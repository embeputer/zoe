const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.ZOE_DB_PATH = path.join(os.tmpdir(), `zoe-test-${process.pid}.sqlite3`);
process.env.ZOE_SECRET = process.env.ZOE_SECRET || 'zoe-test-secret';
// Wall-clock floors off for the suite; one case re-enables to assert them.
process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = '0';
process.env.ZOE_STEP_MIN_ELAPSED_MS = '0';
process.env.ZOE_REDUCED_MOTION_MIN_ELAPSED_MS = '0';
// Per-session limiter off for the suite (it exceeds it legitimately);
// one unit case re-enables to assert it.
process.env.ZOE_RATE_LIMIT_MAX_PER_SESSION = '0';
const assert = require('assert');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
const { execFileSync } = require('child_process');
const {
  createServer,
  checkRateLimit,
  resetRateLimitState,
  RATE_LIMIT_MAX_PER_IP,
  computeLivenessSeriesDigest,
  validateHandLandmarkGeometry,
  verifyAuthenticatorData,
  createFlashPlan,
  validatePixelSeries,
  computePresentationDigest,
} = require('./server');

function request(baseUrl, path, options = {}, cookie) {
  const headers = { ...(options.headers || {}) };
  if (!headers.Origin) {
    try {
      headers.Origin = new URL(baseUrl).origin;
    } catch {
      // Tests use a valid baseUrl; ignore parse failures.
    }
  }
  if (cookie) headers.Cookie = cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { ...options, headers }).then(async (res) => {
    const setCookie = res.headers.get('set-cookie');
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    return { res, body, cookie: setCookie ? setCookie.split(';')[0] : cookie };
  });
}

function evidence(overrides = {}) {
  return {
    startedAt: 1000,
    matchedAt: 1450,
    durationMs: 450,
    frameCount: 12,
    holdFrames: 8,
    landmarkDigest: `landmarks-${Math.random()}`,
    motionDigest: `motion-${Math.random()}`,
    ...overrides,
  };
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

function livenessBody(challengeId, plan, flashPlan, overrides = {}) {
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
    ...overrides,
  };
}

async function main() {
  const exposurePlan = createFlashPlan();
  assert.strictEqual(validatePixelSeries(samplePixelSeries(exposurePlan, 0.35), exposurePlan), null);

  const server = createServer({
    analyzePresentationFrames: async (frames) => ({
      real: frames.every((frame) => frame.face[0] !== 0.36),
      medianScore: 1,
      longestRealRun: 5,
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const protectedWithoutToken = await request(baseUrl, '/api/protected-action', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: 'verified=true' }),
    });
    assert.strictEqual(protectedWithoutToken.res.status, 401);
    let cookie = protectedWithoutToken.cookie;

    const assistedRemoved = await request(baseUrl, '/api/accessibility-request', {
      method: 'POST',
      body: JSON.stringify({ reason: 'camera_or_accessibility' }),
    }, cookie);
    assert.strictEqual(assistedRemoved.res.status, 404);

    const fallbackChallengeRemoved = await request(baseUrl, '/api/fallback/challenge', {
      method: 'POST',
      body: JSON.stringify({ mode: 'emergency_text' }),
    }, cookie);
    assert.strictEqual(fallbackChallengeRemoved.res.status, 404);

    const fallbackVerifyRemoved = await request(baseUrl, '/api/fallback/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: 'fallback-test', answer: 'emergency 1234' }),
    }, cookie);
    assert.strictEqual(fallbackVerifyRemoved.res.status, 404);

    const unverifiedRegisterOptions = await request(baseUrl, '/api/passkey/register/options', { method: 'POST' }, cookie);
    assert.strictEqual(unverifiedRegisterOptions.res.status, 401);

    const livenessWithoutChallenge = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify({ durationMs: 1200, faceFrames: 10, motionScore: 0.12 }),
    }, cookie);
    assert.strictEqual(livenessWithoutChallenge.res.status, 400);

    const livenessChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    assert.strictEqual(livenessChallenge.res.status, 201);
    assert.ok(livenessChallenge.body.challengeId);
    assert.ok(Array.isArray(livenessChallenge.body.plan));
    assert.strictEqual(livenessChallenge.body.plan[0], 'center_hold');
    assert.strictEqual(livenessChallenge.body.plan.length, 3);
    assert.ok(Array.isArray(livenessChallenge.body.flashPlan));
    assert.strictEqual(livenessChallenge.body.flashPlan.length, 4);

    const livenessVerified = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(livenessChallenge.body.challengeId, livenessChallenge.body.plan, livenessChallenge.body.flashPlan)),
    }, cookie);
    assert.strictEqual(livenessVerified.res.status, 200);
    assert.ok(livenessVerified.body.verificationToken);

    const missingMediaChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const missingMediaBody = livenessBody(
      missingMediaChallenge.body.challengeId,
      missingMediaChallenge.body.plan,
      missingMediaChallenge.body.flashPlan,
    );
    delete missingMediaBody.mediaFrames;
    delete missingMediaBody.mediaDigest;
    const missingMedia = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(missingMediaBody),
    }, cookie);
    assert.strictEqual(missingMedia.res.status, 400);

    const minimumMediaChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const minimumMediaFrames = sampleMediaFrames().slice(0, 3);
    const minimumMedia = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(
        minimumMediaChallenge.body.challengeId,
        minimumMediaChallenge.body.plan,
        minimumMediaChallenge.body.flashPlan,
        {
          mediaFrames: minimumMediaFrames,
          mediaDigest: computePresentationDigest(minimumMediaChallenge.body.challengeId, minimumMediaFrames),
        },
      )),
    }, cookie);
    assert.strictEqual(minimumMedia.res.status, 200);

    const sparseMediaChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const sparseMediaFrames = sampleMediaFrames().slice(0, 2);
    const sparseMedia = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(
        sparseMediaChallenge.body.challengeId,
        sparseMediaChallenge.body.plan,
        sparseMediaChallenge.body.flashPlan,
        {
          mediaFrames: sparseMediaFrames,
          mediaDigest: computePresentationDigest(sparseMediaChallenge.body.challengeId, sparseMediaFrames),
        },
      )),
    }, cookie);
    assert.strictEqual(sparseMedia.res.status, 400);
    assert.match(sparseMedia.body.error, /Camera media/);

    const spoofMediaChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const spoofMediaFrames = sampleMediaFrames().map((frame) => ({ ...frame, face: [0.36, 0.15, 0.3, 0.5] }));
    const spoofMedia = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(
        spoofMediaChallenge.body.challengeId,
        spoofMediaChallenge.body.plan,
        spoofMediaChallenge.body.flashPlan,
        {
          mediaFrames: spoofMediaFrames,
          mediaDigest: computePresentationDigest(spoofMediaChallenge.body.challengeId, spoofMediaFrames),
        },
      )),
    }, cookie);
    assert.strictEqual(spoofMedia.res.status, 400);
    assert.match(spoofMedia.body.error, /photo or screen/);

    const wrongPlanPhases = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const issuedPlan = wrongPlanPhases.body.plan;
    const wrongSeriesBody = livenessBody(wrongPlanPhases.body.challengeId, issuedPlan, wrongPlanPhases.body.flashPlan);
    const invalidPhase = issuedPlan.includes('center_to_left') ? 'center_to_right' : 'center_to_left';
    wrongSeriesBody.motionSeries = wrongSeriesBody.motionSeries.map((sample, index) => (
      index === 0 ? { ...sample, p: invalidPhase } : sample
    ));
    wrongSeriesBody.seriesDigest = computeLivenessSeriesDigest(
      wrongPlanPhases.body.challengeId,
      wrongSeriesBody.motionSeries
    );
    const wrongPlan = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(wrongSeriesBody),
    }, cookie);
    assert.strictEqual(wrongPlan.res.status, 400);

    const smoothChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const smoothPlan = smoothChallenge.body.plan;
    const smoothSeries = smoothPlan.flatMap((phaseId, index) => ([
      { p: phaseId, t: index * 300, v: 0.5 },
      { p: phaseId, t: index * 300 + 100, v: 0.5 },
      { p: phaseId, t: index * 300 + 200, v: 0.5 },
    ]));
    const smoothStub = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(smoothChallenge.body.challengeId, smoothPlan, smoothChallenge.body.flashPlan, {
        motionSeries: smoothSeries,
        seriesDigest: computeLivenessSeriesDigest(smoothChallenge.body.challengeId, smoothSeries),
        phases: validLivenessPhases(smoothPlan),
      })),
    }, cookie);
    assert.strictEqual(smoothStub.res.status, 400);

    // Flash is a fallback only: valid pulse evidence succeeds without pixels.
    const pulseOnlyChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const pulseOnly = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(pulseOnlyChallenge.body.challengeId, pulseOnlyChallenge.body.plan, pulseOnlyChallenge.body.flashPlan, {
        pixelSeries: undefined,
      })),
    }, cookie);
    assert.strictEqual(pulseOnly.res.status, 200);
    assert.strictEqual(pulseOnly.body.usedFlashFallback, false);

    // If pulse is inconclusive, the challenge stays open and advertises the
    // explicit flash fallback rather than starting it automatically.
    const darkChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const flatPulse = samplePulseSeries().map((s) => ({ ...s, g: 118 }));
    const flashOffer = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(darkChallenge.body.challengeId, darkChallenge.body.plan, darkChallenge.body.flashPlan, {
        pixelSeries: undefined,
        pulseSeries: flatPulse,
      })),
    }, cookie);
    assert.strictEqual(flashOffer.res.status, 422);
    assert.strictEqual(flashOffer.body.flashAvailable, true);

    // Pixels that ignore the issued flash sequence must be rejected after the
    // user opts into the fallback.
    const darkPixels = samplePixelSeries(darkChallenge.body.flashPlan).map((s) => ({
      ...s,
      f: Buffer.alloc(324).fill(40).toString('base64'),
    }));
    const noFlash = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(darkChallenge.body.challengeId, darkChallenge.body.plan, darkChallenge.body.flashPlan, {
        pixelSeries: darkPixels,
        pulseSeries: flatPulse,
        flashFallback: true,
      })),
    }, cookie);
    assert.strictEqual(noFlash.res.status, 400);

    // A valid flash fallback can verify the still-open challenge.
    const flashSuccessChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const flashWithoutOffer = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(flashSuccessChallenge.body.challengeId, flashSuccessChallenge.body.plan, flashSuccessChallenge.body.flashPlan, {
        pulseSeries: flatPulse,
        flashFallback: true,
      })),
    }, cookie);
    assert.strictEqual(flashWithoutOffer.res.status, 400);
    const flashSuccessOffer = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(flashSuccessChallenge.body.challengeId, flashSuccessChallenge.body.plan, flashSuccessChallenge.body.flashPlan, {
        pixelSeries: undefined,
        pulseSeries: flatPulse,
      })),
    }, cookie);
    assert.strictEqual(flashSuccessOffer.res.status, 422);
    const flashSuccess = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(flashSuccessChallenge.body.challengeId, flashSuccessChallenge.body.plan, flashSuccessChallenge.body.flashPlan, {
        pulseSeries: flatPulse,
        flashFallback: true,
      })),
    }, cookie);
    assert.strictEqual(flashSuccess.res.status, 200);
    assert.strictEqual(flashSuccess.body.usedFlashFallback, true);
    assert.strictEqual(flashSuccess.body.pulseBpm, null);

    // Pulse gates: flat signal, clean injected sine, and out-of-band
    // frequencies must all offer the flash fallback when one is available.
    const flatPulseChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const flatPulseRes = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(flatPulseChallenge.body.challengeId, flatPulseChallenge.body.plan, flatPulseChallenge.body.flashPlan, {
        pulseSeries: flatPulse,
      })),
    }, cookie);
    assert.strictEqual(flatPulseRes.res.status, 422);

    const sinePulseChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const sinePulse = [];
    for (let t = 0; t <= 14000; t += 95) {
      sinePulse.push({ g: 118 + 4 * Math.sin(2 * Math.PI * 1.1 * (t / 1000)), t });
    }
    const sinePulseRes = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(sinePulseChallenge.body.challengeId, sinePulseChallenge.body.plan, sinePulseChallenge.body.flashPlan, {
        pulseSeries: sinePulse,
      })),
    }, cookie);
    assert.strictEqual(sinePulseRes.res.status, 422);

    const offBandChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const offBandPulse = [];
    for (let t = 0; t <= 14000; t += 95) {
      offBandPulse.push({ g: 118 + 5 * Math.sin(2 * Math.PI * 0.2 * (t / 1000)) + 2 * Math.sin(2 * Math.PI * 3.1 * (t / 1000) + 0.9), t });
    }
    const offBandRes = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(offBandChallenge.body.challengeId, offBandChallenge.body.plan, offBandChallenge.body.flashPlan, {
        pulseSeries: offBandPulse,
      })),
    }, cookie);
    assert.strictEqual(offBandRes.res.status, 422);

    // Reduced motion: no flash plan is issued, pixels are not required, and
    // the pulse check alone carries the liveness gate — so it demands a
    // longer measurement window (>=18s span) than the flash-gated path.
    const reducedChallenge = await request(baseUrl, '/api/liveness/challenge', {
      method: 'POST',
      body: JSON.stringify({ reducedMotion: true }),
    }, cookie);
    assert.strictEqual(reducedChallenge.res.status, 201);
    assert.strictEqual(reducedChallenge.body.flashPlan, null);
    const reducedVerify = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(reducedChallenge.body.challengeId, reducedChallenge.body.plan, null, {
        pixelSeries: undefined,
        pulseSeries: samplePulseSeries(20000),
      })),
    }, cookie);
    assert.strictEqual(reducedVerify.res.status, 200);
    assert.ok(reducedVerify.body.pulseBpm > 0);

    // A reduced-motion pulse under the longer window must still be rejected.
    const reducedShortChallenge = await request(baseUrl, '/api/liveness/challenge', {
      method: 'POST',
      body: JSON.stringify({ reducedMotion: true }),
    }, cookie);
    const reducedShortVerify = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(reducedShortChallenge.body.challengeId, reducedShortChallenge.body.plan, null, {
        pixelSeries: undefined,
        pulseSeries: samplePulseSeries(),
      })),
    }, cookie);
    assert.strictEqual(reducedShortVerify.res.status, 400);

    // Wall-clock floor: with the minimum elapsed enforced, an instant
    // challenge-to-verify must be rejected even with valid evidence.
    process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = '60000';
    const fastChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const tooFast = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(fastChallenge.body.challengeId, fastChallenge.body.plan, fastChallenge.body.flashPlan)),
    }, cookie);
    assert.strictEqual(tooFast.res.status, 400);
    process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = '0';

    const noPasskey = await request(baseUrl, '/api/passkey/auth/options', { method: 'POST' }, cookie);
    assert.strictEqual(noPasskey.res.status, 409);

    const verifiedRegisterOptions = await request(baseUrl, '/api/passkey/register/options', {
      method: 'POST',
      body: JSON.stringify({ registrationVerificationToken: livenessVerified.body.verificationToken }),
    }, cookie);
    assert.strictEqual(verifiedRegisterOptions.res.status, 200);
    assert.ok(verifiedRegisterOptions.body.challenge);

    const registerVerify = await request(baseUrl, '/api/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        rawId: `test-credential-${Math.random().toString(36).slice(2)}`,
        clientDataJSON: Buffer.from(JSON.stringify({
          type: 'webauthn.create',
          challenge: verifiedRegisterOptions.body.challenge,
          origin: baseUrl,
        })).toString('base64url'),
        publicKey: Buffer.from('fake-der-key').toString('base64url'),
        alg: -7,
      }),
    }, cookie);
    assert.strictEqual(registerVerify.res.status, 201);

    const passkeyRegistered = await request(baseUrl, '/api/passkey/auth/options', { method: 'POST' }, cookie);
    assert.strictEqual(passkeyRegistered.res.status, 200);

    const passkeyReset = await request(baseUrl, '/api/passkey/reset', { method: 'POST' }, cookie);
    assert.strictEqual(passkeyReset.res.status, 200);
    assert.strictEqual(passkeyReset.body.ok, true);

    // ---- Attestation assurance gates ----
    // Minimal CBOR encoder for building attestationObject fixtures.
    const cborEncodeLen = (major, n) => {
      if (n < 24) return Buffer.from([major | n]);
      if (n < 256) return Buffer.from([major | 24, n]);
      const b = Buffer.alloc(2); b.writeUInt16BE(n); return Buffer.concat([Buffer.from([major | 25]), b]);
      const b4 = Buffer.alloc(4); b4.writeUInt32BE(n); return Buffer.concat([Buffer.from([major | 26]), b4]);
    };
    const cborEncode = (v) => {
      if (typeof v === 'number' && Number.isInteger(v)) {
        const mt = v < 0 ? 0x20 : 0x00;
        const n = v < 0 ? -1 - v : v;
        if (n < 24) return Buffer.from([mt | n]);
        if (n < 256) return Buffer.from([mt | 24, n]);
        const b = Buffer.alloc(2); b.writeUInt16BE(n); return Buffer.concat([Buffer.from([mt | 25]), b]);
        const b4 = Buffer.alloc(4); b4.writeUInt32BE(n); return Buffer.concat([Buffer.from([mt | 26]), b4]);
      }
      if (typeof v === 'string') {
        const b = Buffer.from(v, 'utf8');
        return Buffer.concat([cborEncodeLen(0x60, b.length), b]);
      }
      if (Buffer.isBuffer(v)) return Buffer.concat([cborEncodeLen(0x40, v.length), v]);
      if (Array.isArray(v)) return Buffer.concat([cborEncodeLen(0x80, v.length), ...v.map(cborEncode)]);
      if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        return Buffer.concat([
          cborEncodeLen(0xa0, keys.length),
          ...keys.flatMap((k) => [/^-?\d+$/.test(k) ? cborEncode(Number(k)) : cborEncode(k), cborEncode(v[k])]),
        ]);
      }
      throw new Error(`cborEncode: unsupported ${typeof v}`);
    };

    const spkiToCose = (spkiDer) => {
      const point = spkiDer.subarray(-65);
      return cborEncode({ 1: 2, 3: -7, '-1': 1, '-2': point.subarray(1, 33), '-3': point.subarray(33, 65) });
    };
    const attAuthData = (credId, coseKey) => Buffer.concat([
      crypto.createHash('sha256').update(new URL(baseUrl).hostname).digest(),
      Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(credId.length); return b; })(),
      credId, coseKey,
    ]);
    const attestationObjectFor = (fmt, attStmt, authData) => Buffer.concat([
      cborEncodeLen(0xa0, 3),
      cborEncode('fmt'), cborEncode(fmt),
      cborEncode('attStmt'), attStmt,
      cborEncode('authData'), cborEncode(authData),
    ]).toString('base64url');
    // extrasFor(challenge) lets fixtures sign clientDataJSON carrying the issued challenge.
    const registerWith = async (rawId, credSpki, extrasFor = () => ({})) => {
      const gate = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
      const mint = await request(baseUrl, '/api/liveness/verify', {
        method: 'POST',
        body: JSON.stringify(livenessBody(gate.body.challengeId, gate.body.plan, gate.body.flashPlan)),
      }, gate.cookie);
      const opts = await request(baseUrl, '/api/passkey/register/options', {
        method: 'POST',
        body: JSON.stringify({ registrationVerificationToken: mint.body.verificationToken }),
      }, mint.cookie);
      cookie = opts.cookie;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.body.challenge, origin: baseUrl }));
      const verify = await request(baseUrl, '/api/passkey/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          rawId, clientDataJSON: clientDataJSON.toString('base64url'),
          publicKey: credSpki.toString('base64url'), alg: -7, ...extrasFor(clientDataJSON),
        }),
      }, cookie);
      cookie = verify.cookie;
      return { verify, clientDataJSON };
    };
    const authAssurance = async (rawId, privKey) => {
      const opts = await request(baseUrl, '/api/passkey/auth/options', { method: 'POST' }, cookie);
      cookie = opts.cookie;
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(new URL(baseUrl).hostname).digest(),
        Buffer.from([0x05]), Buffer.alloc(4),
      ]);
      const clientGet = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.body.challenge, origin: baseUrl }));
      const sig = crypto.sign('SHA256', Buffer.concat([authData, crypto.createHash('sha256').update(clientGet).digest()]), privKey);
      const verify = await request(baseUrl, '/api/passkey/auth/verify', {
        method: 'POST',
        body: JSON.stringify({
          rawId, clientDataJSON: clientGet.toString('base64url'),
          authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url'),
        }),
      }, cookie);
      cookie = verify.cookie;
      const redeem = await request(baseUrl, '/api/verify', {
        method: 'POST', body: JSON.stringify({ verificationToken: verify.body.verificationToken }),
      });
      return { verify, redeem };
    };
    const newCred = () => {
      const { publicKey: pub, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const spki = pub.export({ format: 'der', type: 'spki' });
      return { privateKey, spki, rawId: crypto.randomBytes(16).toString('base64url') };
    };

    // fmt 'none' attestation → registers but stays 'standard'.
    {
      const cred = newCred();
      const authData = attAuthData(Buffer.from(cred.rawId, 'base64url'), spkiToCose(cred.spki));
      const { verify } = await registerWith(cred.rawId, cred.spki, () => ({
        attestationObject: attestationObjectFor('none', cborEncodeLen(0xa0, 0), authData),
      }));
      assert.strictEqual(verify.res.status, 201);
      const { redeem } = await authAssurance(cred.rawId, cred.privateKey);
      assert.strictEqual(redeem.body.assurance, 'standard');
    }

    // packed self-attestation (sig proves key possession, not hardware) → 'standard'.
    {
      const cred = newCred();
      const authData = attAuthData(Buffer.from(cred.rawId, 'base64url'), spkiToCose(cred.spki));
      const { verify } = await registerWith(cred.rawId, cred.spki, (clientDataJSON) => ({
        attestationObject: attestationObjectFor('packed', cborEncode({
          alg: -7,
          sig: crypto.sign('SHA256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), cred.privateKey),
        }), authData),
      }));
      assert.strictEqual(verify.res.status, 201);
      const { redeem } = await authAssurance(cred.rawId, cred.privateKey);
      assert.strictEqual(redeem.body.assurance, 'standard');
    }

    // packed + x5c chain to an injected test root → 'strong'.
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe-att-'));
      const run = (args) => execFileSync('openssl', args, { cwd: dir });
      run(['ecparam', '-genkey', '-name', 'prime256v1', '-out', 'root.key']);
      run(['req', '-x509', '-new', '-key', 'root.key', '-out', 'root.pem', '-subj', '/CN=Zoe Test FIDO Root', '-days', '2']);
      run(['ecparam', '-genkey', '-name', 'prime256v1', '-out', 'leaf.key']);
      run(['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Zoe Test Attestation Leaf']);
      run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-sha256']);
      const rootPem = fs.readFileSync(path.join(dir, 'root.pem'), 'utf8');
      const leafDer = execFileSync('openssl', ['x509', '-in', 'leaf.pem', '-outform', 'DER'], { cwd: dir });
      const leafKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'leaf.key'), 'utf8'));

      const savedRoots = process.env.ZOE_FIDO_ROOT_PEMS;
      process.env.ZOE_FIDO_ROOT_PEMS = JSON.stringify([rootPem]);
      try {
        const cred = newCred();
        const authData = attAuthData(Buffer.from(cred.rawId, 'base64url'), spkiToCose(cred.spki));
        const { verify } = await registerWith(cred.rawId, cred.spki, (clientDataJSON) => ({
          attestationObject: attestationObjectFor('packed', cborEncode({
            alg: -7,
            sig: crypto.sign('SHA256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), leafKey),
            x5c: [leafDer],
          }), authData),
        }));
        assert.strictEqual(verify.res.status, 201);
        const { redeem } = await authAssurance(cred.rawId, cred.privateKey);
        assert.strictEqual(redeem.body.assurance, 'strong');

        // A well-formed chain that reaches no known root isn't an error — it
        // registers like self-attestation and stays 'standard' (software keys
        // like Chrome/Android emit self-signed leaves by design).
        run(['req', '-x509', '-new', '-key', 'leaf.key', '-out', 'bad.pem', '-subj', '/CN=Mallory', '-days', '2']);
        const badDer = execFileSync('openssl', ['x509', '-in', 'bad.pem', '-outform', 'DER'], { cwd: dir });
        const cred2 = newCred();
        const authData2 = attAuthData(Buffer.from(cred2.rawId, 'base64url'), spkiToCose(cred2.spki));
        const { verify: badVerify } = await registerWith(cred2.rawId, cred2.spki, (clientDataJSON) => ({
          attestationObject: attestationObjectFor('packed', cborEncode({
            alg: -7,
            sig: crypto.sign('SHA256', Buffer.concat([authData2, crypto.createHash('sha256').update(clientDataJSON).digest()]), leafKey),
            x5c: [badDer],
          }), authData2),
        }));
        assert.strictEqual(badVerify.res.status, 201);
        const { redeem: badRedeem } = await authAssurance(cred2.rawId, cred2.privateKey);
        assert.strictEqual(badRedeem.body.assurance, 'standard');

        // But a garbage cert inside x5c is malformed, not merely untrusted.
        const cred3 = newCred();
        const authData3 = attAuthData(Buffer.from(cred3.rawId, 'base64url'), spkiToCose(cred3.spki));
        const { verify: malformedVerify } = await registerWith(cred3.rawId, cred3.spki, (clientDataJSON) => ({
          attestationObject: attestationObjectFor('packed', cborEncode({
            alg: -7,
            sig: crypto.sign('SHA256', Buffer.concat([authData3, crypto.createHash('sha256').update(clientDataJSON).digest()]), leafKey),
            x5c: [Buffer.from('this is not a certificate')],
          }), authData3),
        }));
        assert.strictEqual(malformedVerify.res.status, 400);
      } finally {
        if (savedRoots === undefined) delete process.env.ZOE_FIDO_ROOT_PEMS;
        else process.env.ZOE_FIDO_ROOT_PEMS = savedRoots;
      }
    }


    const challengeResponse = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
    assert.strictEqual(challengeResponse.res.status, 201);
    assert.ok(challengeResponse.cookie);
    cookie = challengeResponse.cookie;
    let challenge = challengeResponse.body;
    assert.ok(challenge.challengeId);
    assert.strictEqual(challenge.totalSteps, 3);

    const wrongStep = await request(baseUrl, '/api/step', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        stepIndex: 1,
        gestureId: challenge.step.id,
        evidence: evidence(),
      }),
    }, cookie);
    assert.strictEqual(wrongStep.res.status, 400);

    const badThreeGeometry = validateHandLandmarkGeometry('three', [{
      hands: [[
        [0.5, 0.7, 0],
        [0.42, 0.68, 0],
        [0.48, 0.70, 0],
        [0.46, 0.67, 0],
        [0.48, 0.62, 0],
        [0.48, 0.7, 0],
        [0.52, 0.62, 0],
        [0.52, 0.7, 0],
        [0.56, 0.62, 0],
        [0.56, 0.7, 0],
        [0.6, 0.64, 0],
        [0.6, 0.66, 0],
      ]],
    }]);
    assert.ok(badThreeGeometry);

    const goodThreeGeometry = validateHandLandmarkGeometry('three', [{
      hands: [[
        [0.5, 0.75, 0],
        [0.42, 0.72, 0],
        [0.48, 0.68, 0],
        [0.45, 0.71, 0],
        [0.48, 0.62, 0],
        [0.48, 0.5, 0],
        [0.52, 0.62, 0],
        [0.52, 0.48, 0],
        [0.56, 0.62, 0],
        [0.56, 0.49, 0],
        [0.6, 0.66, 0],
        [0.6, 0.68, 0],
      ]],
    }]);
    assert.strictEqual(goodThreeGeometry, null);

    // Thumb folded for "three" uses index MCP, not index PIP (pip-only threshold falsely extends thumb).
    const thumbMcpThreeGeometry = validateHandLandmarkGeometry('three', [{
      hands: [[
        [0.5, 0.75, 0],
        [0.35, 0.72, 0],
        [0.48, 0.70, 0],
        [0.40, 0.735, 0],
        [0.48, 0.62, 0],
        [0.48, 0.5, 0],
        [0.52, 0.62, 0],
        [0.52, 0.48, 0],
        [0.56, 0.62, 0],
        [0.56, 0.49, 0],
        [0.6, 0.66, 0],
        [0.6, 0.68, 0],
      ]],
    }]);
    assert.strictEqual(thumbMcpThreeGeometry, null);

    let finalToken = null;
    for (let i = 0; i < 3; i++) {
      const step = challenge.step;
      const stepResponse = await request(baseUrl, '/api/step', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          stepIndex: step.index,
          gestureId: step.id,
          evidence: evidence({ landmarkDigest: `step-${i}` }),
        }),
      }, cookie);
      assert.strictEqual(stepResponse.res.status, 200);
      challenge = stepResponse.body;
      finalToken = challenge.verificationToken || finalToken;
    }

    assert.ok(finalToken);
    const accepted = await request(baseUrl, '/api/protected-action', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: finalToken }),
    }, cookie);
    assert.strictEqual(accepted.res.status, 200);
    assert.strictEqual(accepted.body.ok, true);

    const replay = await request(baseUrl, '/api/protected-action', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: finalToken }),
    }, cookie);
    assert.strictEqual(replay.res.status, 409);

    const geometryChallenge = await request(baseUrl, '/api/challenge', { method: 'POST' }, cookie);
    cookie = geometryChallenge.cookie;
    let geometryStepChallenge = geometryChallenge.body;
    let guard = 0;
    while (geometryStepChallenge.step && geometryStepChallenge.step.id !== 'three' && guard < 3) {
      const skip = await request(baseUrl, '/api/step', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: geometryStepChallenge.challengeId,
          stepIndex: geometryStepChallenge.step.index,
          gestureId: geometryStepChallenge.step.id,
          evidence: evidence({ landmarkDigest: `skip-${geometryStepChallenge.step.id}` }),
        }),
      }, cookie);
      assert.strictEqual(skip.res.status, 200);
      geometryStepChallenge = skip.body;
      guard += 1;
    }
    if (geometryStepChallenge.step && geometryStepChallenge.step.id === 'three') {
      const badThreeStep = await request(baseUrl, '/api/step', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: geometryStepChallenge.challengeId,
          stepIndex: geometryStepChallenge.step.index,
          gestureId: 'three',
          evidence: {
            ...evidence(),
            landmarkSamples: [{
              hands: [[
                [0.5, 0.75, 0],
                [0.42, 0.72, 0],
                [0.48, 0.70, 0],
                [0.46, 0.71, 0],
                [0.48, 0.62, 0],
                [0.48, 0.7, 0],
                [0.52, 0.62, 0],
                [0.52, 0.7, 0],
                [0.56, 0.62, 0],
                [0.56, 0.7, 0],
                [0.6, 0.64, 0],
                [0.6, 0.66, 0],
              ]],
            }],
          },
        }),
      }, cookie);
      assert.strictEqual(badThreeStep.res.status, 400);
    }

    const rpIdHash = crypto.createHash('sha256').update('127.0.0.1').digest();
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.alloc(4)]);
    const authResult = verifyAuthenticatorData(authData, 'http://127.0.0.1:3000');
    assert.strictEqual(authResult.error, undefined);
    assert.strictEqual(authResult.userVerified, true);

    const noUv = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.alloc(4)]);
    const noUvResult = verifyAuthenticatorData(noUv, 'http://127.0.0.1:3000');
    assert.strictEqual(noUvResult.error, undefined);
    assert.strictEqual(noUvResult.userVerified, false);

    const noUp = Buffer.concat([rpIdHash, Buffer.from([0x04]), Buffer.alloc(4)]);
    assert.ok(verifyAuthenticatorData(noUp, 'http://127.0.0.1:3000').error);

    const wrongRp = Buffer.concat([crypto.createHash('sha256').update('evil.example').digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
    assert.ok(verifyAuthenticatorData(wrongRp, 'http://127.0.0.1:3000').error);

    const rpChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const rpSeries = sampleMotionSeries(rpChallenge.body.plan);
    const rpVerify = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(rpChallenge.body.challengeId, rpChallenge.body.plan, rpChallenge.body.flashPlan, { motionSeries: rpSeries, seriesDigest: computeLivenessSeriesDigest(rpChallenge.body.challengeId, rpSeries) })),
    }, cookie);
    assert.strictEqual(rpVerify.res.status, 200);
    const rpToken = rpVerify.body.verificationToken;

    // A relying party redeems the token without the user's session cookie.
    const rpRedeem = await request(baseUrl, '/api/verify', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: rpToken }),
    });
    assert.strictEqual(rpRedeem.res.status, 200);
    assert.strictEqual(rpRedeem.body.valid, true);
    assert.strictEqual(rpRedeem.body.method, 'face-motion');
    assert.strictEqual(rpRedeem.body.assurance, 'standard');

    const rpReplay = await request(baseUrl, '/api/verify', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: rpToken }),
    });
    assert.strictEqual(rpReplay.res.status, 409);

    const rpBadToken = await request(baseUrl, '/api/verify', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: 'not-a-token' }),
    });
    assert.strictEqual(rpBadToken.res.status, 401);

    resetRateLimitState();
    const testIp = 'rate-limit-test-ip';
    for (let i = 0; i < RATE_LIMIT_MAX_PER_IP; i += 1) {
      const allowed = checkRateLimit(testIp, null);
      assert.strictEqual(allowed.limited, false, `request ${i + 1} should be allowed`);
    }
    const limited = checkRateLimit(testIp, null);
    assert.strictEqual(limited.limited, true);
    assert.strictEqual(limited.scope, 'ip');
    resetRateLimitState();

    // Session-scope cap: an IP under its cap must still be limited when one
    // session exceeds the per-session window max.
    process.env.ZOE_RATE_LIMIT_MAX_PER_SESSION = '3';
    const sid = `test-sid-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual(checkRateLimit(`${testIp}-s`, sid).limited, false);
    }
    const sessionLimited = checkRateLimit(`${testIp}-s`, sid);
    assert.strictEqual(sessionLimited.limited, true);
    assert.strictEqual(sessionLimited.scope, 'session');
    process.env.ZOE_RATE_LIMIT_MAX_PER_SESSION = '0';
    resetRateLimitState();

    // A fresh process on the same DB must still reject the consumed token and
    // must see the registered passkey — proves state survives a restart.
    const childScript = `
      const { createServer } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
      const server = createServer();
      server.listen(0, '127.0.0.1', async () => {
        const base = 'http://127.0.0.1:' + server.address().port;
        const headers = {
          'Content-Type': 'application/json',
          Origin: base,
          Cookie: process.env.ZOE_COOKIE,
        };
        try {
          const opts = await fetch(base + '/api/passkey/auth/options', { method: 'POST', headers });
          const action = await fetch(base + '/api/protected-action', {
            method: 'POST',
            headers,
            body: JSON.stringify({ verificationToken: process.env.ZOE_TOKEN }),
          });
          console.log(JSON.stringify({ options: opts.status, action: action.status }));
        } finally {
          server.close();
        }
      });
    `;
    const childOut = execFileSync(process.execPath, ['-e', childScript], {
      env: { ...process.env, ZOE_COOKIE: cookie, ZOE_TOKEN: finalToken },
    }).toString().trim();
    assert.deepStrictEqual(JSON.parse(childOut), { options: 200, action: 409 });

    console.log('server security regression tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.ZOE_DB_PATH, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
