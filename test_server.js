const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.ZOE_DB_PATH = path.join(os.tmpdir(), `zoe-test-${process.pid}.sqlite3`);
process.env.ZOE_SECRET = process.env.ZOE_SECRET || 'zoe-test-secret';
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

function livenessBody(challengeId, plan, overrides = {}) {
  const motionSeries = sampleMotionSeries(plan);
  return {
    challengeId,
    durationMs: 1200,
    faceFrames: 10,
    motionScore: 0.12,
    phases: validLivenessPhases(plan),
    motionSeries,
    seriesDigest: computeLivenessSeriesDigest(challengeId, motionSeries),
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

    const livenessVerified = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify(livenessBody(livenessChallenge.body.challengeId, livenessChallenge.body.plan)),
    }, cookie);
    assert.strictEqual(livenessVerified.res.status, 200);
    assert.ok(livenessVerified.body.verificationToken);

    const wrongPlanPhases = await request(baseUrl, '/api/liveness/challenge', { method: 'POST' }, cookie);
    const issuedPlan = wrongPlanPhases.body.plan;
    const wrongSeriesBody = livenessBody(wrongPlanPhases.body.challengeId, issuedPlan);
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
      body: JSON.stringify(livenessBody(smoothChallenge.body.challengeId, smoothPlan, {
        motionSeries: smoothSeries,
        seriesDigest: computeLivenessSeriesDigest(smoothChallenge.body.challengeId, smoothSeries),
        phases: validLivenessPhases(smoothPlan),
      })),
    }, cookie);
    assert.strictEqual(smoothStub.res.status, 400);

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
      body: JSON.stringify(livenessBody(rpChallenge.body.challengeId, rpChallenge.body.plan, { motionSeries: rpSeries, seriesDigest: computeLivenessSeriesDigest(rpChallenge.body.challengeId, rpSeries) })),
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
