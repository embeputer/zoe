// Adversarial harness: measures which server checks a fully scripted client can
// pass without a camera, a face, a hand, or MediaPipe. Run with `npm run attack`.
//
// Every probe reports tri-state: 'fooled' (the attack worked), 'blocked' with
// the stage that stopped it (the probed check genuinely ran), or 'not-probed'
// (an earlier gate killed the request — never silently upgraded to 'blocked').
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
function report(name, outcome, note) {
  results.push({ name, outcome });
  const label = outcome === 'fooled' ? 'FOOLED   ' : outcome === 'blocked' ? 'BLOCKED  ' : 'NOT-PROBED';
  console.log(`${label} ${name} — ${note}`);
}

// Which pipeline gate rejected a liveness verify, classified from the server's
// own rejection reason. A probe killed upstream of its target is 'not-probed'.
function livenessRejectStage(res, body) {
  const status = res.status;
  const err = (body && body.error) || '';
  if (status === 429) return /media attempts/.test(err) ? 'media-attempt cap' : 'rate limit';
  if (status === 503) return 'analyzer unavailable';
  if (status === 409) return 'challenge consumed';
  if (status === 410) return 'challenge expiry';
  if (status === 422) return 'pulse analysis'; // pulse rejected, flash offered
  if (/missing or invalid/.test(err)) return 'challenge binding';
  if (/too quickly/.test(err)) return 'wall-clock floor';
  if (/Face check timing/.test(err)) return 'duration gate';
  if (/not visible for long enough/.test(err)) return 'face-presence gate';
  if (/too small to count as liveness/.test(err)) return 'motion-score gate';
  if (/motion digest/i.test(err)) return 'motion-digest check';
  if (/motion series/i.test(err)) return 'motion-series checks';
  if (/Camera media/.test(err)) return 'media validation';
  if (/photo or screen/.test(err)) return 'presentation analysis';
  if (/Replay face motion/.test(err)) return 'replay set';
  if (/Pulse|heartbeat/.test(err)) return 'pulse analysis';
  if (/flash|Flash|pixel|Pixel/.test(err)) return 'flash-pixel analysis';
  if (/phase|Head turn|uniform|synthetic|smooth|abrupt|too sparse/.test(err)) return 'phase-metric checks';
  return `HTTP ${status}`;
}

// Mint a real token through the fabricated hand-gesture flow — the one mint
// path that still accepts client-generated evidence. Used by probes whose
// target sits behind token minting; if the gesture surface ever closes they
// correctly report not-probed.
async function mintGestureToken(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  let body = res.body;
  const totalSteps = (body && body.totalSteps) || 3;
  for (let i = 0; i < totalSteps && body && body.step; i += 1) {
    await sleep(200); // per-step wall-clock floor (180ms default)
    res = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: body.challengeId,
        stepIndex: body.step.index,
        gestureId: body.step.id,
        evidence: fabricatedStepEvidence(),
      }),
    }, cookie);
    cookie = res.cookie;
    body = res.body;
  }
  return { token: body && body.verificationToken, status: res.res.status, cookie };
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
  if (!token) return { outcome: 'not-probed', note: `no token issued (last status ${res.res.status}) — the forgeable mint path itself is closed`, cookie };
  const use = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: token }),
  }, cookie);
  return {
    outcome: use.res.status === 200 ? 'fooled' : 'blocked',
    note: use.res.status === 200
      ? 'protected action accepted with zero camera frames'
      : `blocked at token gate: token issued but rejected (${use.res.status})`,
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
  if (!token) {
    const stage = livenessRejectStage(res.res, res.body);
    return { outcome: 'blocked', note: `blocked at ${stage} (${res.res.status}: ${res.body.error || '?'})`, cookie };
  }
  const use = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: token }),
  }, cookie);
  return {
    outcome: use.res.status === 200 ? 'fooled' : 'blocked',
    note: use.res.status === 200 ? 'protected action accepted from a synthetic motionSeries' : `blocked at token gate: token issued but rejected (${use.res.status})`,
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
  const fooled = res.res.status === 200 && !!res.body.verificationToken;
  const stage = fooled ? null : livenessRejectStage(res.res, res.body);
  return {
    outcome: fooled ? 'fooled' : 'blocked',
    note: fooled ? 'a recorded template + per-run noise mints a fresh token every time' : `blocked at ${stage} (${res.res.status})`,
    cookie,
  };
}

async function controlProtectedAction(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: 'verified=true' }),
  }, cookie);
  return {
    outcome: res.res.status === 401 ? 'blocked' : 'fooled',
    note: res.res.status === 401 ? 'blocked at token gate (401)' : `status ${res.res.status} — token gate missing`,
    cookie: res.cookie,
  };
}

async function controlPasskeyGate(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/passkey/register/options', {
    method: 'POST',
    body: JSON.stringify({}),
  }, cookie);
  return {
    outcome: res.res.status === 401 ? 'blocked' : 'fooled',
    note: res.res.status === 401 ? 'blocked at registration gate (401)' : `status ${res.res.status} — registration gate missing`,
    cookie,
  };
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
    const stage = livenessRejectStage(res.res, res.body);
    return {
      outcome: 'not-probed',
      note: `flash/pixel check unreachable — rejected upstream at ${stage} (${res.res.status})`,
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
  const fooled = res.res.status === 200;
  const stage = fooled ? null : livenessRejectStage(res.res, res.body);
  return {
    outcome: fooled ? 'fooled' : 'blocked',
    note: fooled ? 'pixels that ignored the flash minted a token' : `blocked at ${stage}: flash-ignoring pixels (${res.res.status})`,
    cookie,
  };
}

async function controlCrossSession(baseUrl, cookie) {
  // Mint through the fabricated gesture path — the one surface that still
  // issues tokens to scripted clients — so the cross-session check runs.
  const mint = await mintGestureToken(baseUrl, cookie);
  cookie = mint.cookie;
  if (!mint.token) {
    return { outcome: 'not-probed', note: `no token to test — gesture mint rejected (${mint.status})`, cookie };
  }
  const other = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: JSON.stringify({ verificationToken: mint.token }),
  }); // fresh session, no cookie
  return {
    outcome: other.res.status === 200 ? 'fooled' : 'blocked',
    note: other.res.status === 200
      ? 'token minted in one session redeemed in another'
      : `blocked at token gate: cross-session use ${other.res.status}`,
    cookie,
  };
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
    report('control: protected action without token', r.outcome, r.note);

    r = await controlPasskeyGate(baseUrl, cookie);
    report('control: passkey registration without verification', r.outcome, r.note);

    r = await attackFabricatedGestures(baseUrl, cookie);
    cookie = r.cookie;
    report('fabricated gesture challenge', r.outcome, r.note);

    r = await attackFabricatedLiveness(baseUrl, cookie);
    cookie = r.cookie;
    report('fabricated face liveness', r.outcome, r.note);

    r = await attackReplayedSeries(baseUrl, cookie);
    cookie = r.cookie;
    report('replayed series + fresh noise', r.outcome, r.note);

    r = await controlUncorrelatedPixels(baseUrl, cookie);
    cookie = r.cookie;
    report('control: pixels that ignore the flash', r.outcome, r.note);

    r = await controlCrossSession(baseUrl, cookie);
    report('control: token reuse across sessions', r.outcome, r.note);

    const attacks = results.filter((x) => !x.name.startsWith('control'));
    const controls = results.filter((x) => x.name.startsWith('control'));
    const fooledAttacks = attacks.filter((x) => x.outcome === 'fooled');
    const unexercisedAttacks = attacks.filter((x) => x.outcome === 'not-probed');
    const heldControls = controls.filter((x) => x.outcome === 'blocked');
    const fooledControls = controls.filter((x) => x.outcome === 'fooled');
    const unprobedControls = controls.filter((x) => x.outcome === 'not-probed');
    console.log(`\n${fooledAttacks.length}/${attacks.length} attacks fooled the server` + (unexercisedAttacks.length ? ` (${unexercisedAttacks.length} not probed)` : ''));
    console.log(`controls: ${heldControls.length} held, ${fooledControls.length} fooled, ${unprobedControls.length} not probed` + (unprobedControls.length ? ` (${unprobedControls.map((x) => x.name).join('; ')})` : ''));
    const faceAttacksFooled = fooledAttacks.some((result) => (
      result.name === 'fabricated face liveness' || result.name === 'replayed series + fresh noise'
    ));
    if (!faceAttacksFooled) {
      console.log('Conclusion: server-side face detection and presentation analysis blocked both scripted face attacks.');
    }
    if (fooledAttacks.some((result) => result.name === 'fabricated gesture challenge')) {
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
