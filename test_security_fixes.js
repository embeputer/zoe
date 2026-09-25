const path = require('path');
const os = require('os');
process.env.ZOE_DB_PATH = path.join(os.tmpdir(), `zoe-security-test-${process.pid}.sqlite3`);
process.env.ZOE_SECRET = process.env.ZOE_SECRET || 'zoe-security-test-secret';
process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = '0';
process.env.ZOE_STEP_MIN_ELAPSED_MS = '0';
process.env.ZOE_REDUCED_MOTION_MIN_ELAPSED_MS = '0';
process.env.ZOE_RATE_LIMIT_MAX_PER_SESSION = '0';

const assert = require('assert');
const crypto = require('crypto');
const {
  createServer,
  sessions,
  resetRateLimitState,
  computeLivenessSeriesDigest,
  computePresentationDigest,
} = require('./server');

function request(baseUrl, path, options = {}, cookie) {
  const headers = { ...(options.headers || {}) };
  if (!headers.Origin) {
    try {
      headers.Origin = new URL(baseUrl).origin;
    } catch {
      // ignored: tests always use a valid baseUrl
    }
  }
  if (cookie) headers.Cookie = cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' }).then(async (res) => {
    const setCookie = res.headers.get('set-cookie');
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { res, body, cookie: setCookie ? setCookie.split(';')[0] : cookie, setCookie };
  });
}

function decodeTokenPayload(token) {
  const parts = token.split('.');
  assert.strictEqual(parts.length, 2, 'verification token should be encoded.signature');
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}

function gaussian() {
  const u = Math.max(Math.random(), 1e-9);
  const v = Math.max(Math.random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Fabricated pixel evidence matching an issued flash plan: baseline-lit frames
// with sensor noise, shifted toward each flash color inside its window.
function samplePixelSeries(flashPlan, flashExposureGain = 1) {
  const baseline = [40, 45, 50];
  const last = flashPlan[flashPlan.length - 1];
  const endMs = last.o + last.d + 300;
  const samples = [];
  for (let t = 0; t <= endMs; t += 75) {
    const active = flashPlan.find((f) => t >= f.o && t <= f.o + f.d);
    const mean = active
      ? baseline.map((v, i) => (v + active.c[i] * 0.5) * flashExposureGain)
      : baseline;
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

// Green-channel means with a physiologic-band pulse (fundamental + harmonic +
// drift + noise) — shaped like a real rPPG signal.
function samplePulseSeries(spanMs = 14000) {
  const samples = [];
  const w1 = 2 * Math.PI * 1.17;
  const w2 = 2 * Math.PI * 2.34;
  const wd = 2 * Math.PI * 0.08;
  for (let t = 0; t <= spanMs; t += 95) {
    const s = t / 1000;
    const g = 118 + 3.5 * Math.sin(w1 * s) + 1.1 * Math.sin(w2 * s + 0.7) + 1.5 * Math.sin(wd * s + 1.2) + gaussian() * 2.2;
    samples.push({ g: Math.round(g * 100) / 100, t });
  }
  return samples;
}

function validLivenessPhases(plan) {
  const motion = plan.slice(1);
  return [
    { id: plan[0], holdJitterRms: 0.002, tortuosity: 1.01, transitionMs: 320, sampleCount: 10 },
    { id: motion[0], holdJitterRms: 0.003, tortuosity: 1.05, transitionMs: 600, sampleCount: 12 },
    { id: motion[1], holdJitterRms: 0.0025, tortuosity: 1.04, transitionMs: 550, sampleCount: 11 },
  ];
}

function sampleMotionSeries(plan) {
  return plan.flatMap((phaseId, index) => ([
    { p: phaseId, t: index * 200, v: 0.1 + index * 0.02 },
    { p: phaseId, t: index * 200 + 80, v: 0.12 + index * 0.02 },
    { p: phaseId, t: index * 200 + 160, v: 0.11 + index * 0.02 },
  ]));
}

const jpeg = require('jpeg-js');
const mediaFrameImages = Array.from({ length: 5 }, (_, frameIndex) => {
  const width = 320;
  const height = 240;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x + frameIndex * 7) % 256;
      data[offset + 1] = (y + frameIndex * 11) % 256;
      data[offset + 2] = (x + y + frameIndex * 13) % 256;
      data[offset + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 70).data.toString('base64');
});

function sampleMediaFrames() {
  return mediaFrameImages.map((image, index) => ({
    t: index * 700,
    face: [0.35, 0.15, 0.3, 0.5],
    image,
  }));
}

function livenessBody(challengeId, plan, flashPlan) {
  const motionSeries = sampleMotionSeries(plan);
  const mediaFrames = sampleMediaFrames();
  return {
    challengeId,
    durationMs: 1200,
    faceFrames: 10,
    motionScore: 0.12,
    phases: validLivenessPhases(plan),
    motionSeries,
    seriesDigest: computeLivenessSeriesDigest(challengeId, motionSeries),
    pixelSeries: flashPlan ? samplePixelSeries(flashPlan) : undefined,
    pulseSeries: samplePulseSeries(),
    mediaFrames,
    mediaDigest: computePresentationDigest(challengeId, mediaFrames),
  };
}

// Mints a verification token through the public face-motion flow and returns
// { token, cookie } — the cookie carries the issuing session for bound calls.
async function mintToken(baseUrl, cookie) {
  const gate = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
  assert.strictEqual(gate.res.status, 201, 'liveness challenge should mint');
  const verified = await request(baseUrl, '/api/liveness/verify', {
    method: 'POST',
    body: JSON.stringify(livenessBody(gate.body.challengeId, gate.body.plan, gate.body.flashPlan)),
  }, gate.cookie);
  assert.strictEqual(verified.res.status, 200, 'liveness verify should succeed');
  assert.ok(verified.body.verificationToken);
  return { token: verified.body.verificationToken, cookie: verified.cookie };
}

async function main() {
  const server = createServer({
    analyzePresentationFrames: async () => ({ real: true, medianScore: 1, longestRealRun: 5 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    resetRateLimitState();

    // 1. The signed payload carries no sid/challengeId.
    {
      const { token } = await mintToken(baseUrl, null);
      const payload = decodeTokenPayload(token);
      assert.strictEqual('sid' in payload, false, 'payload must not contain sid');
      assert.strictEqual('challengeId' in payload, false, 'payload must not contain challengeId');
      for (const key of ['type', 'action', 'method', 'assurance', 'nonce', 'iat', 'exp']) {
        assert.ok(key in payload, `payload is missing ${key}`);
      }
      console.log('ok - verification token payload carries no sid/challengeId');
    }

    // 2. /api/verify works with no cookie and does not set one.
    {
      const { token } = await mintToken(baseUrl, null);
      const redeem = await request(baseUrl, '/api/verify', {
        method: 'POST',
        body: JSON.stringify({ verificationToken: token }),
      });
      assert.strictEqual(redeem.res.status, 200, 'redeem should succeed without a cookie');
      assert.strictEqual(redeem.body.valid, true);
      assert.strictEqual(redeem.setCookie, null, '/api/verify must not mint a session cookie');
      console.log('ok - /api/verify works with no cookie and sets none');
    }

    // 3. Issued-token redemption survives a fresh sessions Map (restart sim).
    {
      const { token, cookie } = await mintToken(baseUrl, null);
      // Wipe the in-memory session entry: the cookie still names the session
      // but sessions.get(sid) misses, so redemption must fall back to the
      // persisted issued_tokens row.
      const sid = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
      assert.ok(sessions.delete(sid), 'session should exist in memory before wipe');
      const redeem = await request(baseUrl, '/api/verify', {
        method: 'POST',
        body: JSON.stringify({ verificationToken: token }),
      });
      assert.strictEqual(redeem.res.status, 200, 'redeem should survive session wipe');
      assert.strictEqual(redeem.body.valid, true);
      console.log('ok - issued-token redemption survives a fresh sessions map');
    }

    // 4. Two interleaved passkey options requests do not invalidate each other.
    {
      const { token, cookie } = await mintToken(baseUrl, null);
      const body = JSON.stringify({ registrationVerificationToken: token });
      const optsA = await request(baseUrl, '/api/passkey/register/options', { method: 'POST', body }, cookie);
      assert.strictEqual(optsA.res.status, 200);
      // Second registration needs a fresh gate token; mint one and interleave.
      const { token: tokenB } = await mintToken(baseUrl, optsA.cookie);
      const optsB = await request(baseUrl, '/api/passkey/register/options', {
        method: 'POST',
        body: JSON.stringify({ registrationVerificationToken: tokenB }),
      }, optsA.cookie);
      assert.strictEqual(optsB.res.status, 200);
      assert.notStrictEqual(optsA.body.challenge, optsB.body.challenge, 'challenges must differ');
      // The first challenge must still be redeemable: build a clientDataJSON
      // around it and assert the server does not 410 (it may 400 on fixture
      // fidelity, but the challenge entry itself must be found).
      const clientData = Buffer.from(JSON.stringify({
        type: 'webauthn.create', challenge: optsA.body.challenge, origin: baseUrl,
      })).toString('base64url');
      const verify = await request(baseUrl, '/api/passkey/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          rawId: crypto.randomBytes(16).toString('base64url'),
          clientDataJSON: clientData,
          publicKey: crypto.randomBytes(91).toString('base64url'),
          alg: -7,
        }),
      }, optsB.cookie);
      assert.notStrictEqual(verify.res.status, 410, 'first challenge must still be live after second options call');
      console.log('ok - interleaved passkey options do not invalidate each other');
    }

    // 5. Malformed cookie header does not 500.
    {
      const res = await fetch(`${baseUrl}/api/challenge`, {
        method: 'POST',
        headers: {
          Origin: baseUrl,
          Cookie: 'zoe_sid=%E0%A4%A; malformed=%; =broken',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.notStrictEqual(res.status, 500, 'malformed cookie must not crash the request');
      assert.strictEqual(res.status, 201, 'malformed cookie should still mint a fresh session');
      console.log('ok - malformed cookie header does not 500');
    }
  } finally {
    server.close();
  }

  console.log('test_security_fixes: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
