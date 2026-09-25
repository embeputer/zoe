'use strict';

// attack_agent.js — API-level adversarial probes: what an autonomous agent or
// headless script can do against Zoe's trust boundaries. The media-content
// surface (what pixels/models actually accept) is covered by attack_server.js;
// this harness fabricates a complete liveness body so protocol-level probes
// exercise the real pipeline instead of dying on a missing field. Run with
// `npm run attack:agent`.
//
// Every probe reports tri-state: 'fooled' (the attack worked), 'blocked' with
// the stage that stopped it (the target check was genuinely exercised), or
// 'not-probed' (an earlier gate killed the request — never silently upgraded
// to 'blocked').

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// A throwaway DB file (not :memory:) so the session-farming probe can count
// persisted rows. The directory is removed in main()'s finally.
process.env.ZOE_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-attack-agent-')),
  'probe.sqlite3',
);
// Wall-clock floors stay on but are shortened for runtime — a mint still
// costs real seconds per attempt, not milliseconds.
process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = process.env.ZOE_LIVENESS_MIN_ELAPSED_MS ?? '2000';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const jpeg = require('jpeg-js');
const { createServer, computePresentationDigest } = require('./server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function report(name, outcome, note) {
  results.push({ name, outcome });
  const label = outcome === 'fooled' ? 'FOOLED   ' : outcome === 'blocked' ? 'BLOCKED  ' : 'NOT-PROBED';
  console.log(`${label} ${name} — ${note}`);
}

// The harness mutates ZOE_* env floors to keep probes fast; wrap every change
// so a throw can't leave a floor lowered for later probes.
async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
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

// --- Pipeline stages, in the order /api/liveness/verify checks them ---

const LIVENESS_STAGES = [
  'challenge binding',
  'challenge consumed',
  'challenge expiry',
  'wall-clock floor',
  'duration gate',
  'face-presence gate',
  'motion-score gate',
  'motion-digest check',
  'motion-series checks',
  'phase-metric checks',
  'media validation',
  'media-attempt cap',
  'presentation analysis',
  'pulse analysis',
  'flash-pixel analysis',
  'replay set',
];
const stageRank = (stage) => LIVENESS_STAGES.indexOf(stage);

// Classify which gate rejected a liveness verify from the server's own reason.
function livenessRejectStage(res) {
  const status = res.res.status;
  const err = (res.body && res.body.error) || '';
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

// --- Fabricated evidence ---

// The digest algorithm is shipped in app.js; an attacker reimplements it freely.
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
  // 148 samples — well above the pulse gate's 90-sample minimum.
  for (let t = 0; t <= 14000; t += 95) {
    const s = t / 1000;
    const g = 118 + 3.5 * Math.sin(w1 * s) + 1.1 * Math.sin(w2 * s + 0.7) + 1.5 * Math.sin(wd * s + 1.2) + gaussian() * 2.2;
    samples.push({ g: Math.round(g * 100) / 100, t });
  }
  return samples;
}

// Same procedural face attack_server.js submits: passes every structural media
// check (count, spacing, span, JPEG size/dimensions, uniqueness, digest) so the
// request reaches server-side presentation analysis — which is expected to
// reject it, because a drawn face is not a camera image.
function fabricatedMediaFrames() {
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
  return mediaFrames;
}

// A complete, structurally-valid liveness verify body for an issued challenge:
// every field today's validators check — plan-bound motion series + digest, a
// 148-sample pulse stream, challenge-bound media frames + mediaDigest, and the
// flash pixel series — fabricated. Keep it in this one helper so body-shape
// changes land in one place.
function fabricatedLivenessBody(challenge, overrides = {}) {
  const motionSeries = fabricatedMotionSeries(challenge.plan);
  const mediaFrames = fabricatedMediaFrames();
  return {
    challengeId: challenge.challengeId,
    durationMs: 2400,
    faceFrames: 30,
    motionScore: 0.35,
    motionSeries,
    seriesDigest: attackerSeriesDigest(challenge.challengeId, motionSeries),
    pixelSeries: challenge.flashPlan ? fabricatedPixelSeries(challenge.flashPlan) : undefined,
    pulseSeries: fabricatedPulseSeries(),
    mediaFrames,
    mediaDigest: computePresentationDigest(challenge.challengeId, mediaFrames),
    ...overrides,
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
    // landmarkSamples intentionally omitted: server-side hand geometry only
    // runs when present.
    motionStats: { holdJitterRms: 0.003, formingMotion: 0.002 },
  };
}

async function freshChallenge(baseUrl, cookie) {
  const res = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  return { challenge: res.body, cookie: res.cookie };
}

// Mint a real token through the fabricated hand-gesture flow — the one mint
// path that still accepts client-generated evidence (fabricated liveness is
// probed separately and dies at presentation analysis). Token-dependent
// probes hang off this; if the gesture surface ever closes they correctly
// report not-probed.
async function mintGestureToken(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  let body = res.body;
  const totalSteps = (body && body.totalSteps) || 3;
  for (let i = 0; i < totalSteps && body && body.step; i += 1) {
    await sleep(200); // per-step wall-clock floor (180ms default)
    res = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: {
        challengeId: body.challengeId,
        stepIndex: body.step.index,
        gestureId: body.step.id,
        evidence: fabricatedStepEvidence(),
      },
    }, cookie);
    cookie = res.cookie;
    body = res.body;
  }
  return { token: body && body.verificationToken, status: res.res.status, cookie };
}

// --- Probes ---

// Wall-clock floor: a challenge→verify round-trip faster than the pulse
// stage's minimum must be rejected regardless of evidence quality. The body is
// complete so only the floor can explain an instant rejection.
async function probeInstantVerification(baseUrl, cookie) {
  const t0 = Date.now();
  const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
  const res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody(challenge),
  }, c1);
  const elapsed = Date.now() - t0;
  if (res.res.status === 200 && res.body && res.body.verificationToken) {
    return { outcome: 'fooled', note: `challenge-to-token in ${elapsed}ms real time (claiming ~20s of camera evidence)`, cookie: res.cookie };
  }
  const stage = livenessRejectStage(res);
  return {
    outcome: stage === 'wall-clock floor' ? 'blocked' : 'not-probed',
    note: stage === 'wall-clock floor'
      ? `instant verify rejected (${res.res.status}) after ${elapsed}ms — blocked at wall-clock floor`
      : `rejected at ${stage} (${res.res.status}) after ${elapsed}ms — wall-clock floor unexercised`,
    cookie: res.cookie,
  };
}

// The complete fabricated liveness body against today's validators: field
// checks, plan-bound motion series, media-shape validation, then server-side
// presentation analysis on the fabricated frames. The stage that stops it is
// the report.
async function probeLivenessMint(baseUrl, cookie) {
  const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
  await sleep(2100); // wall-clock floor (shortened to 2s for the harness)
  const res = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: fabricatedLivenessBody(challenge),
  }, c1);
  if (res.res.status === 200 && res.body && res.body.verificationToken) {
    return { outcome: 'fooled', note: 'full fabricated liveness body minted a verification token', cookie: res.cookie };
  }
  const stage = livenessRejectStage(res);
  const reachedPad = stage === 'presentation analysis';
  return {
    outcome: reachedPad ? 'blocked' : 'not-probed',
    note: reachedPad
      ? `fabricated media rejected at presentation analysis (${res.res.status}) — a drawn face is not a camera image`
      : `rejected at ${stage} (${res.res.status}) — presentation analysis never exercised`,
    cookie: res.cookie,
  };
}

// Zoe ID end-to-end without a human or a platform authenticator: register a
// software-generated P-256 key behind a gesture-minted token, then mint a
// passkey token by self-asserting the UV flag. 'strong' requires a verified
// hardware attestation chain, so the scripted lifecycle should cap at
// 'standard'.
async function probeScriptedZoeId(baseUrl, cookie) {
  const mint = await mintGestureToken(baseUrl, cookie);
  cookie = mint.cookie;
  if (!mint.token) {
    return { outcome: 'not-probed', note: `gate token unavailable — gesture mint rejected (${mint.status})`, cookie };
  }

  let res = await request(baseUrl, '/api/passkey/register/options', {
    method: 'POST',
    body: { registrationVerificationToken: mint.token },
  }, cookie);
  cookie = res.cookie;
  if (res.res.status !== 200) {
    return { outcome: 'blocked', note: `blocked at registration gate (${res.res.status}: ${res.body && res.body.error})`, cookie };
  }
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
  if (res.res.status !== 201) {
    return { outcome: 'blocked', note: `blocked at attestation verify (${res.res.status}: ${res.body && res.body.error})`, cookie };
  }

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
  if (!token) {
    return { outcome: 'blocked', note: `blocked at assertion verify (${res.res.status}: ${res.body && res.body.error})`, cookie };
  }
  const redeem = await request(baseUrl, '/api/verify', {
    method: 'POST',
    body: { verificationToken: token },
  }, cookie);
  const assurance = redeem.body && redeem.body.assurance;
  return {
    outcome: redeem.res.status === 200 && assurance === 'strong' ? 'fooled' : 'blocked',
    note: `Zoe ID lifecycle fully scripted; token assurance '${assurance}' — ${assurance === 'strong' ? "software key minted 'strong'" : "blocked at attestation gate: software key capped at 'standard'"}`,
    cookie: redeem.cookie,
  };
}

// A token must be single-use across BOTH redemption paths.
async function probeDoubleRedeem(baseUrl, cookie) {
  const mint = await mintGestureToken(baseUrl, cookie);
  cookie = mint.cookie;
  if (!mint.token) {
    return { outcome: 'not-probed', note: `no token to redeem — gesture mint rejected (${mint.status})`, cookie };
  }
  const [a, b] = await Promise.all([
    request(baseUrl, '/api/protected-action', { method: 'POST', body: { verificationToken: mint.token } }, cookie),
    request(baseUrl, '/api/verify', { method: 'POST', body: { verificationToken: mint.token } }),
  ]);
  const accepted = [a.res.status, b.res.status].filter((s) => s === 200).length;
  return {
    outcome: accepted > 1 ? 'fooled' : 'blocked',
    note: `protected-action ${a.res.status} + /api/verify ${b.res.status} — ${accepted} redemption(s) accepted`,
    cookie: a.cookie,
  };
}

// Per-step wall-clock floor: a step submitted <180ms after issuance must be
// rejected even when the claimed durations inside evidence look plausible.
async function probeInstantGestures(baseUrl, cookie) {
  let res = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
  cookie = res.cookie;
  const t0 = Date.now();
  let challenge = res.body;
  let rejectedAt = null;
  for (let i = 0; i < 3; i++) {
    res = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: {
        challengeId: challenge.challengeId,
        stepIndex: challenge.step.index,
        gestureId: challenge.step.id,
        evidence: fabricatedStepEvidence(),
      },
    }, cookie);
    cookie = res.cookie;
    if (res.res.status !== 200 || !res.body.step) {
      rejectedAt = res.res.status;
      challenge = { verificationToken: res.body && res.body.verificationToken };
      break;
    }
    challenge = res.body;
  }
  const elapsed = Date.now() - t0;
  const token = challenge.verificationToken;
  return {
    outcome: token ? 'fooled' : 'blocked',
    note: token
      ? `3 gesture steps → token in ${elapsed}ms (each claimed 450ms)`
      : `rejected at a step (${rejectedAt}) — blocked at step wall-clock floor`,
    cookie,
  };
}

// Body fuzzing on the liveness verify gate: every malformed payload must be a
// clean 4xx at the stage that owns the field — never a 200 or a crash, and a
// rejection at an EARLIER stage does not count (the anomaly was never
// evaluated). Floor is lowered for this probe so field validation is what gets
// exercised; timing is covered by the instant probe.
async function probeBodyFuzz(baseUrl, cookie) {
  // [label, patch, stage that owns the field]
  const cases = [
    ['durationMs as string', { durationMs: '2400' }, 'duration gate'],
    ['durationMs negative', { durationMs: -5000 }, 'duration gate'],
    ['durationMs huge', { durationMs: 1e18 }, 'duration gate'],
    ['faceFrames null', { faceFrames: null }, 'face-presence gate'],
    ['motionScore object', { motionScore: { v: 1 } }, 'motion-score gate'],
    ['seriesDigest wrong type', { seriesDigest: 1234 }, 'motion-digest check'],
    ['mediaFrames missing', { mediaFrames: undefined }, 'media validation'],
    ['mediaDigest junk', { mediaDigest: 'z'.repeat(64) }, 'media validation'],
    ['pulseSeries oversized', { pulseSeries: new Array(401).fill({ g: 120, t: 1 }) }, 'pulse analysis'],
    ['pulseSeries too few', { pulseSeries: [{ g: 120, t: 0 }] }, 'pulse analysis'],
    ['pulse g out of range', { pulseSeries: fabricatedPulseSeries().map((s) => ({ ...s, g: 999 })) }, 'pulse analysis'],
    ['pulse t non-monotonic', { pulseSeries: fabricatedPulseSeries().map((s, i) => ({ ...s, t: i % 2 ? s.t : s.t + 100000 })) }, 'pulse analysis'],
  ];
  return withEnv('ZOE_LIVENESS_MIN_ELAPSED_MS', '0', async () => {
    const anomalies = [];
    const unexercised = [];
    let exercised = 0;
    for (const [label, patch, expectedStage] of cases) {
      const { challenge, cookie: c1 } = await freshChallenge(baseUrl, cookie);
      cookie = c1;
      const res = await request(baseUrl, '/api/liveness/verify', {
        method: 'POST',
        body: fabricatedLivenessBody(challenge, patch),
      }, cookie);
      cookie = res.cookie;
      if (res.res.status < 400 || res.res.status >= 500) {
        anomalies.push(`${label} → ${res.res.status}`);
        continue;
      }
      const stage = livenessRejectStage(res);
      if (stageRank(stage) >= stageRank(expectedStage)) exercised += 1;
      else unexercised.push(`${label} (died at ${stage})`);
    }
    const notes = [`${exercised}/${cases.length} cases exercised, all cleanly rejected`];
    if (unexercised.length) notes.push(`${unexercised.length} never reached their gate: ${unexercised.join('; ')}`);
    return {
      outcome: anomalies.length ? 'fooled' : (exercised > 0 ? 'blocked' : 'not-probed'),
      note: anomalies.length ? `malformed payloads accepted: ${anomalies.join('; ')}` : notes.join('; '),
      cookie,
    };
  });
}

// Anonymous requests mint cookies + memory sessions, but rows must persist
// only once a session holds real state — verified by counting rows in the same
// SQLite file the server writes.
async function probeSessionFarming(baseUrl, cookie) {
  let probeDb;
  try {
    probeDb = new DatabaseSync(process.env.ZOE_DB_PATH);
  } catch (err) {
    return { outcome: 'not-probed', note: `cannot inspect server DB (${err.message})`, cookie };
  }
  try {
    const countRows = () => probeDb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    const before = countRows();
    let cookies = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`${baseUrl}/api/protected-action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (res.headers.get('set-cookie')) cookies += 1;
    }
    const anonDelta = countRows() - before;
    // Control: a fresh session that gains real state must persist exactly one row.
    const probe = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, null);
    cookie = probe.cookie || cookie;
    const realDelta = probe.res.status === 201 ? countRows() - before - anonDelta : null;
    const note = `${cookies}/12 anonymous POSTs minted cookies, ${anonDelta} persisted session rows` + (realDelta === null
      ? ' (control challenge failed — persistence claim unverified)'
      : `; control challenge on a fresh session → +${realDelta} row, lazy persistence ${realDelta === 1 ? 'verified' : 'BROKEN'}`);
    return {
      outcome: anonDelta > 0 || realDelta === 0 ? 'fooled' : 'blocked',
      note,
      cookie,
    };
  } finally {
    probeDb.close();
  }
}

// Per-session limiting is real but every request here mints a fresh session,
// so it never binds; the brake that must hold is the 120 req/min IP cap
// (the bucket has been counting since the server started, so the first 429
// arrives well under 120 requests into this probe).
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
    outcome: hitAt < 0 || hitAt > 120 ? 'fooled' : 'blocked',
    note: hitAt > 0
      ? `first 429 at request ${hitAt}; ${sids.size} distinct sessions — blocked at IP cap; session rotation gains nothing, distributed IPs bypass it`
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
  const fooled = other.res.status === 200 || guess.res.status === 200;
  return {
    outcome: fooled ? 'fooled' : 'blocked',
    note: `cross-session verify ${other.res.status}, guessed challengeId ${guess.res.status} — ${fooled ? 'a foreign challenge was reachable' : 'blocked at challenge binding'}`,
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
    cookie = r.cookie; report('instant verification (wall-clock floor)', r.outcome, r.note);

    r = await probeInstantGestures(baseUrl, cookie);
    cookie = r.cookie; report('instant gesture flow (step wall-clock)', r.outcome, r.note);

    r = await probeLivenessMint(baseUrl, cookie);
    cookie = r.cookie; report('fabricated liveness mint (media + presentation analysis)', r.outcome, r.note);

    r = await probeScriptedZoeId(baseUrl, cookie);
    cookie = r.cookie; report('scripted Zoe ID (software passkey)', r.outcome, r.note);

    r = await probeDoubleRedeem(baseUrl, cookie);
    cookie = r.cookie; report('token double-redeem', r.outcome, r.note);

    r = await probeChallengeBinding(baseUrl, cookie);
    cookie = r.cookie; report('challenge session binding + id guessing', r.outcome, r.note);

    r = await probeBodyFuzz(baseUrl, cookie);
    cookie = r.cookie; report('malformed body fuzzing', r.outcome, r.note);

    r = await probeSessionFarming(baseUrl, cookie);
    cookie = r.cookie; report('anonymous session farming', r.outcome, r.note);

    r = await probeRateLimit(baseUrl, cookie); // last: burns the IP budget
    report('rate limiting', r.outcome, r.note);

    const fooled = results.filter((x) => x.outcome === 'fooled');
    const blocked = results.filter((x) => x.outcome === 'blocked');
    const unprobed = results.filter((x) => x.outcome === 'not-probed');
    console.log(`\n${fooled.length} probes fooled the server; ${blocked.length} blocked at their target stage; ${unprobed.length} not probed.`);
    for (const item of unprobed) console.log(`  not probed: ${item.name}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.dirname(process.env.ZOE_DB_PATH), { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
