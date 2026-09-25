// Adversarial harness: measures which server checks a fully scripted client can
// pass without a camera, a face, a hand, or MediaPipe. Run with `npm run attack`.
process.env.ZOE_DB_PATH = ':memory:';
// Wall-clock floors stay on but are shortened for runtime — the harness still
// has to burn real seconds per attempt, not mint instantly.
process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = process.env.ZOE_LIVENESS_MIN_ELAPSED_MS ?? '2000';
const crypto = require('crypto');
const jpeg = require('jpeg-js');
const { createServer } = require('./server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function attackerMediaDigest(challengeId, mediaFrames) {
  return crypto.createHash('sha256').update(`${challengeId}\n${JSON.stringify(mediaFrames)}`).digest('hex');
}

function fabricatedMediaEvidence(challengeId) {
  const width = 320;
  const height = 240;
  const mediaFrames = [];
  for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const dx = x - 160 - frameIndex;
        const dy = y - 116;
        const inFace = (dx * dx) / (62 * 62) + (dy * dy) / (82 * 82) < 1;
        const eye = ((dx + 22) ** 2 + (dy + 18) ** 2 < 45) || ((dx - 22) ** 2 + (dy + 18) ** 2 < 45);
        const mouth = Math.abs(dy - 28) < 3 && Math.abs(dx) < 28;
        const color = eye || mouth ? [38, 28, 24] : inFace ? [202, 154, 128] : [72, 90, 116];
        data[offset] = color[0] + frameIndex;
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = 255;
      }
    }
    mediaFrames.push({
      t: frameIndex * 700,
      face: [0.3, 0.14, 0.4, 0.68],
      image: jpeg.encode({ data, width, height }, 72).data.toString('base64'),
    });
  }
  return {
    mediaFrames,
    mediaDigest: attackerMediaDigest(challengeId, mediaFrames),
  };
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

// Forged pixel stream: baseline-lit frames with synthetic sensor noise,
// shifted toward each issued flash color inside its window. Proves the pixel
// check raises attack cost but remains forgeable without server-side vision.
function fabricatedPixelSeries(flashPlan) {
  const baseline = [40, 45, 50];
  const last = flashPlan[flashPlan.length - 1];
  const endMs = last.o + last.d + 300;
  const samples = [];
  for (let t = 0; t <= endMs; t += 75) {
    const active = flashPlan.find((f) => t >= f.o && t <= f.o + f.d);
    const mean = active ? baseline.map((v, i) => v + active.c[i] * 0.5) : baseline;
    const f = Buffer.alloc(324);
    for (let i = 0; i < f.length; i++) {
      f[i] = Math.max(0, Math.min(255, Math.round(mean[i % 3] + gaussian() * 6)));
    }
    const b = Buffer.alloc(12);
    for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, 30 + gaussian() * 3));
    samples.push({ t, f: f.toString('base64'), b: b.toString('base64') });
  }
  return samples;
}

// Forged rPPG pulse: a fundamental + 2nd harmonic + slow drift + noise in the
// physiologic band passes the spectral gates — raising attack cost again but
// proving the check remains forgeable without server-side vision.
function fabricatedPulseSeries() {
  const samples = [];
  const w1 = 2 * Math.PI * 1.17;
  const w2 = 2 * Math.PI * 2.34;
  const wd = 2 * Math.PI * 0.08;
  for (let t = 0; t <= 14000; t += 95) {
    const s = t / 1000;
    const g = 118 + 3.5 * Math.sin(w1 * s) + 1.1 * Math.sin(w2 * s + 0.7) + 1.5 * Math.sin(wd * s + 1.2) + gaussian() * 2.2;
    samples.push({ g: Math.round(g * 100) / 100, t });
  }
  return samples;
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
    await sleep(200); // step floor: >=180ms between gesture steps
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
  const { challengeId, plan, flashPlan } = res.body;
  const motionSeries = fabricatedMotionSeries(plan);
  await sleep(2100); // wall-clock floor: >=2s (shortened from the 14s default)
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
      pixelSeries: flashPlan ? fabricatedPixelSeries(flashPlan) : undefined,
      pulseSeries: fabricatedPulseSeries(),
      ...fabricatedMediaEvidence(challengeId),
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
  await sleep(2100);
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: res.body.challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries: noisy,
      seriesDigest: attackerSeriesDigest(res.body.challengeId, noisy),
      pixelSeries: res.body.flashPlan ? fabricatedPixelSeries(res.body.flashPlan) : undefined,
      pulseSeries: fabricatedPulseSeries(),
      ...fabricatedMediaEvidence(res.body.challengeId),
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

async function controlUncorrelatedPixels(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const { challengeId, plan, flashPlan } = res.body;
  const motionSeries = fabricatedMotionSeries(plan);
  // Pixels that never respond to the issued flash sequence must be rejected.
  const flatPixels = fabricatedPixelSeries(flashPlan).map((s) => ({
    ...s,
    f: Buffer.alloc(324).fill(40).toString('base64'),
  }));
  const flatPulse = fabricatedPulseSeries().map((s) => ({ ...s, g: 118 }));
  await sleep(2100);
  // First let the pulse gate fail so the server explicitly opens the fallback.
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
      pulseSeries: flatPulse,
      ...fabricatedMediaEvidence(challengeId),
    }),
  }, cookie);
  if (res.res.status !== 422 || !res.body.flashAvailable) {
    const blockedByPad = res.res.status === 400 && /photo or screen/.test(res.body.error || '');
    return {
      fooled: !blockedByPad,
      note: blockedByPad ? 'blocked earlier by server-side camera analysis' : `flash fallback was not offered cleanly: ${res.res.status}`,
      cookie,
    };
  }
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
      pixelSeries: flatPixels,
      pulseSeries: flatPulse,
      flashFallback: true,
      ...fabricatedMediaEvidence(challengeId),
    }),
  }, cookie);
  return { fooled: res.res.status === 200, note: `flash-ignoring pixels: ${res.res.status}`, cookie };
}

async function controlCrossSession(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const { challengeId, plan, flashPlan } = res.body;
  const motionSeries = fabricatedMotionSeries(plan);
  await sleep(2100); // wall-clock floor: >=2s (shortened from the 14s default)
  res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId,
      durationMs: 2400,
      faceFrames: 30,
      motionScore: 0.35,
      motionSeries,
      seriesDigest: attackerSeriesDigest(challengeId, motionSeries),
      pixelSeries: flashPlan ? fabricatedPixelSeries(flashPlan) : undefined,
      pulseSeries: fabricatedPulseSeries(),
      ...fabricatedMediaEvidence(challengeId),
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

    r = await controlUncorrelatedPixels(baseUrl, cookie);
    cookie = r.cookie;
    report('control: pixels that ignore the flash', r.fooled, r.note);

    r = await controlCrossSession(baseUrl, cookie);
    report('control: token reuse across sessions', r.fooled, r.note);

    const fooled = results.filter((x) => x.fooled && !x.name.startsWith('control'));
    const controls = results.filter((x) => x.name.startsWith('control'));
    console.log(`\n${fooled.length}/3 attacks fooled the server; controls blocked: ${controls.filter((x) => !x.fooled).length}/${controls.length}`);
    const faceAttacksFooled = fooled.some((result) => (
      result.name === 'fabricated face liveness' || result.name === 'replayed series + fresh noise'
    ));
    if (!faceAttacksFooled) {
      console.log('Conclusion: server-side face detection and presentation analysis blocked both scripted face attacks.');
    }
    if (fooled.some((result) => result.name === 'fabricated gesture challenge')) {
      console.log('The hand-gesture path remains forgeable because it still accepts bounded client-generated evidence.');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
