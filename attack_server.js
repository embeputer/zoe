// Adversarial harness: measures which server checks a fully scripted client can
// pass without a camera, a face, a hand, or MediaPipe. Run with `npm run attack`.
process.env.ZOE_DB_PATH = ':memory:';
const crypto = require('crypto');
const { createServer } = require('./server');

function request(baseUrl, path, options = {}, cookie) {
  const headers = { ...(options.headers || {}) };
  if (!headers.Origin) headers.Origin = new URL(baseUrl).origin;
  if (cookie) headers.Cookie = cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { ...options, headers }).then(async (res) => {
    const setCookie = res.headers.get('set-cookie');
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    return { res, body, cookie: setCookie ? setCookie.split(';')[0] : cookie };
  });
}

function gaussian() {
  const u = Math.max(Math.random(), 1e-9);
  const v = Math.max(Math.random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// The digest algorithm is shipped in app.js; an attacker reimplements it freely.
function attackerSeriesDigest(challengeId, motionSeries) {
  return crypto.createHash('sha256').update(`${challengeId}\n${JSON.stringify(motionSeries)}`).digest('hex');
}

function fabricatedStepEvidence() {
  return {
    startedAt: 1000,
    matchedAt: 1450,
    durationMs: 450,
    frameCount: 12,
    holdFrames: 8,
    landmarkDigest: crypto.randomBytes(8).toString('hex'),
    motionDigest: crypto.randomBytes(8).toString('hex'),
    // landmarkSamples intentionally omitted: server-side hand geometry only runs when present.
    motionStats: { holdJitterRms: 0.003, formingMotion: 0.002 },
  };
}

function fabricatedMotionSeries(plan) {
  const series = [];
  let t = 0;
  for (const phaseId of plan) {
    const isHold = phaseId === 'center_hold';
    const spanMs = isHold ? 900 : 600;
    const n = 10;
    let v = isHold ? 0.1 : 0.3;
    for (let i = 0; i < n; i++) {
      v += gaussian() * 0.01;
      series.push({ p: phaseId, t: t + Math.round((spanMs * i) / (n - 1)), v });
    }
    t += spanMs + 120;
  }
  return series;
}

const results = [];
function report(name, fooled, note) {
  results.push({ name, fooled, note });
  console.log(`${fooled ? 'FOOLED ' : 'BLOCKED'}  ${name} — ${note}`);
}

async function attackFabricatedGestures(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  let challenge = res.body;
  for (let i = 0; i < 3; i++) {
    res = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        stepIndex: challenge.step.index,
        gestureId: challenge.step.id,
        evidence: fabricatedStepEvidence(),
      }),
    }, cookie);
    challenge = res.body;
  }
  const token = challenge.verificationToken;
  if (!token) return { fooled: false, note: `no token issued (last status ${res.res.status})`, cookie };
  const use = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: token }),
  }, cookie);
  return {
    fooled: use.res.status === 200,
    note: use.res.status === 200 ? 'protected action accepted with zero camera frames' : `token issued but rejected (${use.res.status})`,
    cookie,
  };
}

async function attackFabricatedLiveness(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const { challengeId, plan } = res.body;
  const motionSeries = fabricatedMotionSeries(plan);
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
    }),
  }, cookie);
  const token = res.body.verificationToken;
  if (!token) return { fooled: false, note: `rejected (${res.res.status}: ${res.body.error || '?'})`, cookie };
  const use = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: token }),
  }, cookie);
  return {
    fooled: use.res.status === 200,
    note: use.res.status === 200 ? 'protected action accepted from a synthetic motionSeries' : `token issued but rejected (${use.res.status})`,
    cookie,
  };
}

async function attackReplayedSeries(baseUrl, cookie) {
  // One "recorded" series resubmitted with fresh noise: defeats the exact-digest replay set.
  let res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const template = fabricatedMotionSeries(res.body.plan);
  const noisy = template.map((s) => ({ ...s, v: s.v + gaussian() * 0.0004 }));
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: res.body.challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries: noisy,
      seriesDigest: attackerSeriesDigest(res.body.challengeId, noisy),
    }),
  }, cookie);
  return {
    fooled: res.res.status === 200 && !!res.body.verificationToken,
    note: res.res.status === 200 ? 'a recorded template + per-run noise mints a fresh token every time' : `rejected (${res.res.status})`,
    cookie,
  };
}

async function controlProtectedAction(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: 'verified=true' }),
  }, cookie);
  return { fooled: res.res.status !== 401, note: `status ${res.res.status}`, cookie: res.cookie };
}

async function controlPasskeyGate(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/passkey/register/options', {
    method: 'POST',
    body: JSON.stringify({}),
  }, cookie);
  return { fooled: res.res.status === 200, note: `status ${res.res.status}`, cookie };
}

async function controlCrossSession(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const { challengeId, plan } = res.body;
  const motionSeries = fabricatedMotionSeries(plan);
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
    }),
  }, cookie);
  const token = res.body.verificationToken;
  if (!token) return { fooled: false, note: 'could not mint token to test', cookie };
  const other = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: token }),
  }); // fresh session, no cookie
  return { fooled: other.res.status === 200, note: `cross-session use: ${other.res.status}`, cookie };
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`attacking ${baseUrl} — all evidence below is fabricated, no camera involved\n`);

  try {
    let cookie = null;

    let r = await controlProtectedAction(baseUrl, cookie);
    cookie = r.cookie;
    report('control: protected action without token', r.fooled, r.note);

    r = await controlPasskeyGate(baseUrl, cookie);
    report('control: passkey registration without verification', r.fooled, r.note);

    r = await attackFabricatedGestures(baseUrl, cookie);
    cookie = r.cookie;
    report('fabricated gesture challenge', r.fooled, r.note);

    r = await attackFabricatedLiveness(baseUrl, cookie);
    cookie = r.cookie;
    report('fabricated face liveness', r.fooled, r.note);

    r = await attackReplayedSeries(baseUrl, cookie);
    cookie = r.cookie;
    report('replayed series + fresh noise', r.fooled, r.note);

    r = await controlCrossSession(baseUrl, cookie);
    report('control: token reuse across sessions', r.fooled, r.note);

    const fooled = results.filter((x) => x.fooled && !x.name.startsWith('control'));
    const controls = results.filter((x) => x.name.startsWith('control'));
    console.log(`\n${fooled.length}/3 attacks fooled the server; controls blocked: ${controls.filter((x) => !x.fooled).length}/${controls.length}`);
    if (fooled.length) {
      console.log('Conclusion: server-side evidence checks gate *statistics of submitted numbers*, not real media.');
      console.log('A scripted client mints valid verification tokens with no camera, face, or hand present.');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
