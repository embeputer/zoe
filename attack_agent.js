'use strict';

// attack_agent.js — API-level adversarial probes: what an autonomous agent or
// headless script can do against Zoe's trust boundaries beyond fabricated
// media evidence (that surface is covered by attack_server.js). Run with
// `npm run attack:agent`.

const crypto = require('node:crypto');
const { createServer } = require('./server');

const results = [];
function report(name, fooled, note) {
  results.push({ name, fooled });
  console.log(`${fooled ? 'FOOLED ' : 'BLOCKED'}  ${name} — ${note}`);
}
function info(name, note) {
  results.push({ name, fooled: null });
  console.log(`INFO    ${name} — ${note}`);
}

async function request(baseUrl, path, options = {}, cookie) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'POST',
    headers,
    body: options.rawBody !== undefined ? options.rawBody : JSON.stringify(options.body || {}),
  });
  const setCookie = res.headers.get('set-cookie');
  const nextCookie = setCookie ? setCookie.split(';')[0] : cookie;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body, cookie: nextCookie };
}

function gaussian() {
  const u = Math.max(Math.random(), 1e-9);
  const v = Math.max(Math.random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- Fabricated evidence (same shape as attack_server.js) ---

function attackerSeriesDigest(challengeId, motionSeries) {
  return crypto.createHash('sha256')
    .update(`${challengeId}\n${JSON.stringify(motionSeries)}`)
    .digest('hex');
}

function fabricatedMotionSeries(plan) {
  const series = [];
  let t = 0;
  for (const phaseId of plan) {
    const isHold = phaseId === 'center_hold';
    const spanMs = isHold ? 900 : 600;
    let v = isHold ? 0.1 : 0.3;
    for (let i = 0; i < 10; i++) {
      v += gaussian() * 0.01;
      series.push({ p: phaseId, t: t + Math.round((spanMs * i) / 9), v });
    }
    t += spanMs + 120;
  }
  return series;
}

function fabricatedPixelSeries(flashPlan) {
  const baseline = [40, 45, 50];
  const last = flashPlan[flashPlan.length - 1];
  const endMs = last.o + last.d + 300;
  const samples = [];
  for (let t = 0; t <= endMs; t += 75) {
    const active = flashPlan.find((f) => t >= f.o && t <= f.o + f.d);
    const mean = active ? baseline.map((v, i) => v + active.c[i] * 0.5) : baseline;
    const f = Buffer.alloc(324);
    for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(255, Math.round(mean[i % 3] + gaussian() * 6)));
    const b = Buffer.alloc(12);
    for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, 30 + gaussian() * 3));
    samples.push({ t, f: f.toString('base64'), b: b.toString('base64') });
  }
  return samples;
}

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

// A complete, structurally-valid liveness verify body for an issued challenge.
function fabricatedLivenessBody(challenge, overrides = {}) {
  const motionSeries = fabricatedMotionSeries(challenge.plan);
  return {
    challengeId: challenge.challengeId,
    durationMs: 2400,
    faceFrames: 30,
    motionScore: 0.35,
    motionSeries,
    seriesDigest: attackerSeriesDigest(challenge.challengeId, motionSeries),
    pixelSeries: challenge.flashPlan ? fabricatedPixelSeries(challenge.flashPlan) : undefined,
    pulseSeries: fabricatedPulseSeries(),
    ...overrides,
  };
}

async function freshChallenge(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  return { challenge: res.body, cookie: res.cookie };
}

async function mintToken(baseUrl, cookie) {
  const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
  const res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody(challenge),
  }, c1);
  return { token: res.body && res.body.verificationToken, cookie: res.cookie, status: res.res.status };
}

// --- Probes ---

// The server measures only TTLs; every duration is client-claimed. A full
// "verification" (motion + 14s pulse + flash) submitted ~instantly is accepted.
async function probeInstantVerification(baseUrl, cookie) {
  const t0 = Date.now();
  const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
  const res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody(challenge),
  }, c1);
  const elapsed = Date.now() - t0;
  return {
    fooled: res.res.status === 200 && !!res.body.verificationToken,
    note: `challenge-to-token in ${elapsed}ms real time (claiming ~20s of camera evidence)`,
    cookie: res.cookie,
  };
}

// Zoe ID end-to-end without a human or a platform authenticator: register a
// software-generated P-256 key behind a forged liveness token, then mint a
// 'strong'-assurance passkey token by self-asserting the UV flag.
async function probeScriptedZoeId(baseUrl, cookie) {
  const mint = await mintToken(baseUrl, cookie);
  cookie = mint.cookie;
  if (!mint.token) return { fooled: false, note: `could not mint gate token (${mint.status})`, cookie };

  let res = await request(baseUrl, '/api/passkey/register/options', {
    method: 'POST',
    body: { registrationVerificationToken: mint.token },
  }, cookie);
  cookie = res.cookie;
  if (res.res.status !== 200) return { fooled: false, note: `register gate rejected (${res.res.status})`, cookie };
  const regChallenge = res.body.challenge;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawId = `agent-credential-${crypto.randomBytes(8).toString('hex')}`;
  const clientCreate = JSON.stringify({ type: 'webauthn.create', challenge: regChallenge, origin: baseUrl });
  res = await request(baseUrl, '/api/passkey/register/verify', {
    method: 'POST',
    body: {
      rawId,
      clientDataJSON: Buffer.from(clientCreate).toString('base64url'),
      publicKey: spki.toString('base64url'),
      alg: -7,
    },
  }, cookie);
  cookie = res.cookie;
  if (res.res.status !== 201) return { fooled: false, note: `register/verify rejected (${res.res.status})`, cookie };

  res = await request(baseUrl, '/api/passkey/auth/options', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const authChallenge = res.body.challenge;
  const rpIdHash = crypto.createHash('sha256').update(new URL(baseUrl).hostname).digest();
  // flags 0x05 = UP|UV — we assert user verification ourselves.
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]);
  const clientGet = JSON.stringify({ type: 'webauthn.get', challenge: authChallenge, origin: baseUrl });
  const clientBytes = Buffer.from(clientGet);
  const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientBytes).digest()]);
  const signature = crypto.sign('SHA256', signed, privateKey);
  res = await request(baseUrl, '/api/passkey/auth/verify', {
    method: 'POST',
    body: {
      rawId,
      clientDataJSON: clientBytes.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  }, cookie);
  cookie = res.cookie;
  const token = res.body && res.body.verificationToken;
  if (!token) return { fooled: false, note: `auth rejected (${res.res.status}: ${res.body && res.body.error})`, cookie };
  const use = await request(baseUrl, '/api/protected-action', {
    method: 'POST',
    body: { verificationToken: token },
  }, cookie);
  return {
    fooled: use.res.status === 200,
    note: `Zoe ID lifecycle fully scripted; token minted with 'strong' assurance (self-asserted UV flag), protected action ${use.res.status}`,
    cookie: use.cookie,
  };
}

// A token must be single-use across BOTH redemption paths.
async function probeDoubleRedeem(baseUrl, cookie) {
  const mint = await mintToken(baseUrl, cookie);
  if (!mint.token) return { fooled: false, note: `could not mint token (${mint.status})`, cookie: mint.cookie };
  const [a, b] = await Promise.all([
    request(baseUrl, '/api/protected-action', { method: 'POST', body: { verificationToken: mint.token } }, mint.cookie),
    request(baseUrl, '/api/verify', { method: 'POST', body: { verificationToken: mint.token } }),
  ]);
  const accepted = [a.res.status, b.res.status].filter((s) => s === 200).length;
  return { fooled: accepted > 1, note: `protected-action ${a.res.status} + /api/verify ${b.res.status} — ${accepted} redemption(s)`, cookie: a.cookie };
}

// Gesture flow accepts instant submissions: per-step durations are
// client-claimed and never compared to server-measured elapsed time.
async function probeInstantGestures(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const t0 = Date.now();
  let challenge = res.body;
  for (let i = 0; i < 3; i++) {
    res = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: {
        challengeId: challenge.challengeId,
        stepIndex: challenge.step.index,
        gestureId: challenge.step.id,
        evidence: {
          startedAt: 1000, matchedAt: 1450, durationMs: 450, frameCount: 12, holdFrames: 8,
          landmarkDigest: crypto.randomBytes(8).toString('hex'),
          motionDigest: crypto.randomBytes(8).toString('hex'),
          motionStats: { holdJitterRms: 0.003, formingMotion: 0.002 },
        },
      },
    }, cookie);
    cookie = res.cookie;
    challenge = res.body;
  }
  const elapsed = Date.now() - t0;
  const token = challenge.verificationToken;
  return {
    fooled: !!token,
    note: token ? `3 gesture steps → token in ${elapsed}ms (each claimed 450ms)` : `rejected at step`,
    cookie,
  };
}

// Body fuzzing on the liveness verify gate: every malformed payload must be a
// clean 400, never a 200 or a crash.
async function probeBodyFuzz(baseUrl, cookie) {
  const anomalies = [];
  const cases = [
    ['durationMs as string', { durationMs: '2400' }],
    ['durationMs negative', { durationMs: -5000 }],
    ['durationMs huge', { durationMs: 1e18 }],
    ['faceFrames null', { faceFrames: null }],
    ['motionScore object', { motionScore: { v: 1 } }],
    ['pulseSeries oversized', { pulseSeries: new Array(401).fill({ g: 120, t: 1 }) }],
    ['pulseSeries too few', { pulseSeries: [{ g: 120, t: 0 }] }],
    ['pixelSeries oversized', { pixelSeries: new Array(141).fill({ t: 0, f: 'AAAA', b: 'AAAA' }) }],
    ['pulse g out of range', { pulseSeries: fabricatedPulseSeries().map((s) => ({ ...s, g: 999 })) }],
    ['pulse t non-monotonic', { pulseSeries: fabricatedPulseSeries().map((s, i) => ({ ...s, t: i % 2 ? s.t : s.t + 100000 })) }],
    ['seriesDigest wrong type', { seriesDigest: 1234 }],
  ];
  for (const [label, patch] of cases) {
    const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
    cookie = c1;
    const res = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: fabricatedLivenessBody(challenge, patch),
    }, cookie);
    cookie = res.cookie;
    if (res.res.status !== 400) anomalies.push(`${label} → ${res.res.status}`);
  }
  return { fooled: anomalies.length > 0, note: anomalies.length ? anomalies.join('; ') : 'all malformed payloads cleanly rejected', cookie };
}

// Every anonymous request persists a session row. Capped by per-IP rate limit
// but unbounded across IPs — a slow session-table growth vector.
async function probeSessionFarming(baseUrl) {
  const sids = new Set();
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${baseUrl}/api/protected-action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) sids.add(sc.split(';')[0]);
  }
  return { fooled: sids.size >= 12, note: `${sids.size}/12 anonymous POSTs each minted+persisted a fresh session`, cookie: null };
}

// Per-session rate limiting is disabled (ZOE_RATE_LIMIT_MAX_PER_SESSION=0);
// the only brake is 120 req/min per IP, and cookie rotation doesn't help.
async function probeRateLimit(baseUrl, cookie) {
  let hitAt = -1;
  const sids = new Set();
  for (let i = 0; i < 130 && hitAt < 0; i++) {
    const res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, null); // fresh cookie every request
    const sc = res.res.headers.get('set-cookie');
    if (sc) sids.add(sc.split(';')[0]);
    if (res.res.status === 429) hitAt = i + 1;
  }
  return {
    fooled: hitAt < 0 || hitAt > 120,
    note: hitAt > 0
      ? `first 429 at request ${hitAt}; ${sids.size} distinct sessions — IP cap holds, session rotation gains nothing, distributed IPs bypass it`
      : `no 429 after 130 requests — rate limit inert`,
    cookie,
  };
}

// A challenge issued to one session is unreachable from another; challenge ids
// are unguessable and the pending slot is per-session.
async function probeChallengeBinding(baseUrl, cookie) {
  const { challenge } = await freshChallenge(baseUrl, cookie);
  const other = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody(challenge),
  }); // no cookie → fresh session
  const guess = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody({ ...challenge, challengeId: crypto.randomBytes(24).toString('base64url') }),
  }, cookie);
  return {
    fooled: other.res.status === 200 || guess.res.status === 200,
    note: `cross-session verify ${other.res.status}, guessed challengeId ${guess.res.status}`,
    cookie,
  };
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`probing ${baseUrl} — agent-level surface, no camera anywhere\n`);

  let cookie = null;
  try {
    let r = await probeInstantVerification(baseUrl, cookie);
    cookie = r.cookie; report('instant verification (no wall-clock)', r.fooled, r.note);

    r = await probeInstantGestures(baseUrl, cookie);
    cookie = r.cookie; report('instant gesture flow (no wall-clock)', r.fooled, r.note);

    r = await probeScriptedZoeId(baseUrl, cookie);
    cookie = r.cookie; report('scripted Zoe ID (software passkey)', r.fooled, r.note);

    r = await probeDoubleRedeem(baseUrl, cookie);
    cookie = r.cookie; report('token double-redeem', r.fooled, r.note);

    r = await probeChallengeBinding(baseUrl, cookie);
    cookie = r.cookie; report('challenge session binding + id guessing', r.fooled, r.note);

    r = await probeBodyFuzz(baseUrl, cookie);
    cookie = r.cookie; report('malformed body fuzzing', r.fooled, r.note);

    const sf = await probeSessionFarming(baseUrl);
    info('anonymous session farming', sf.note);

    r = await probeRateLimit(baseUrl, cookie); // last: burns the IP budget
    report('rate limiting', r.fooled, r.note);

    const fooled = results.filter((x) => x.fooled === true);
    const blocked = results.filter((x) => x.fooled === false);
    console.log(`\n${fooled.length} probes fooled the server; ${blocked.length} blocked.`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
