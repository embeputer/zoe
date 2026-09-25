const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.ZOE_DB_PATH = path.join(os.tmpdir(), `zoe-test-${process.pid}.sqlite3`);
process.env.ZOE_SECRET = process.env.ZOE_SECRET || 'zoe-test-secret';
// Wall-clock floors off for the suite; one case re-enables to assert them.
process.env.ZOE_LIVENESS_MIN_ELAPSED_MS = '0';
process.env.ZOE_STEP_MIN_ELAPSED_MS = '0';
process.env.ZOE_REDUCED_MOTION_MIN_ELAPSED_MS = '0';
const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createServer, checkRateLimit, resetRateLimitState, RATE_LIMIT_MAX_PER_IP, computeLivenessSeriesDigest, validateHandLandmarkGeometry, verifyAuthenticatorData } = require('./server');

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
function samplePixelSeries(flashPlan) {
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

function livenessBody(challengeId, plan, flashPlan, overrides = {}) {
  const motionSeries = sampleMotionSeries(plan);
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
    ...overrides,
  };
}

async function main() {
  const server = createServer();
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

    // Pixels that ignore the issued flash sequence must be rejected.
    const darkChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const darkPixels = samplePixelSeries(darkChallenge.body.flashPlan).map((s) => ({
      ...s,
      f: Buffer.alloc(324).fill(40).toString('base64'),
    }));
    const noFlash = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(darkChallenge.body.challengeId, darkChallenge.body.plan, darkChallenge.body.flashPlan, {
        pixelSeries: darkPixels,
      })),
    }, cookie);
    assert.strictEqual(noFlash.res.status, 400);

    // Pulse gates: flat signal, clean injected sine, and out-of-band
    // frequencies must all be rejected.
    const flatPulseChallenge = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const flatPulse = samplePulseSeries().map((s) => ({ ...s, g: 118 }));
    const flatPulseRes = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(flatPulseChallenge.body.challengeId, flatPulseChallenge.body.plan, flatPulseChallenge.body.flashPlan, {
        pulseSeries: flatPulse,
      })),
    }, cookie);
    assert.strictEqual(flatPulseRes.res.status, 400);

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
    assert.strictEqual(sinePulseRes.res.status, 400);

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
    assert.strictEqual(offBandRes.res.status, 400);

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
