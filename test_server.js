const assert = require('assert');
const { createServer } = require('./server');

function request(baseUrl, path, options = {}, cookie) {
  const headers = { ...(options.headers || {}) };
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

    const assisted = await request(baseUrl, '/api/accessibility-request', {
      method: 'POST',
      body: JSON.stringify({ reason: 'camera_or_accessibility' }),
    }, cookie);
    assert.strictEqual(assisted.res.status, 202);
    assert.ok(assisted.body.requestId);
    assert.strictEqual(assisted.body.verificationToken, undefined);
    cookie = assisted.cookie;

    const assistedTokenAttempt = await request(baseUrl, '/api/protected-action', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: assisted.body.requestId }),
    }, cookie);
    assert.strictEqual(assistedTokenAttempt.res.status, 401);

    const assistedRepeat = await request(baseUrl, '/api/accessibility-request', {
      method: 'POST',
      body: JSON.stringify({ reason: 'camera_or_accessibility' }),
    }, cookie);
    assert.strictEqual(assistedRepeat.res.status, 429);

    const legacyTextFallback = await request(baseUrl, '/api/fallback/challenge', {
      method: 'POST',
      body: JSON.stringify({ mode: 'text' }),
    }, cookie);
    assert.strictEqual(legacyTextFallback.res.status, 400);

    const emergencyTextFallback = await request(baseUrl, '/api/fallback/challenge', {
      method: 'POST',
      body: JSON.stringify({ mode: 'emergency_text' }),
    }, cookie);
    assert.strictEqual(emergencyTextFallback.res.status, 201);
    const emergencyTextAnswer = emergencyTextFallback.body.prompt.match(/"([^"]+)"/)[1];
    const emergencyTextVerified = await request(baseUrl, '/api/fallback/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: emergencyTextFallback.body.challengeId, answer: emergencyTextAnswer }),
    }, cookie);
    assert.strictEqual(emergencyTextVerified.res.status, 200);
    assert.ok(emergencyTextVerified.body.verificationToken);

    const emergencyTextAccepted = await request(baseUrl, '/api/protected-action', {
      method: 'POST',
      body: JSON.stringify({ verificationToken: emergencyTextVerified.body.verificationToken }),
    }, cookie);
    assert.strictEqual(emergencyTextAccepted.res.status, 200);

    const emergencyRepeat = await request(baseUrl, '/api/fallback/challenge', {
      method: 'POST',
      body: JSON.stringify({ mode: 'emergency_audio' }),
    }, cookie);
    assert.strictEqual(emergencyRepeat.res.status, 429);

    const emergencyAudioFallback = await request(baseUrl, '/api/fallback/challenge', {
      method: 'POST',
      body: JSON.stringify({ mode: 'emergency_audio' }),
    });
    assert.strictEqual(emergencyAudioFallback.res.status, 201);
    assert.ok(emergencyAudioFallback.body.speakText);
    const emergencyAudioVerified = await request(baseUrl, '/api/fallback/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: emergencyAudioFallback.body.challengeId,
        answer: emergencyAudioFallback.body.speakText.replace(/\s+/g, ''),
      }),
    }, emergencyAudioFallback.cookie);
    assert.strictEqual(emergencyAudioVerified.res.status, 200);
    assert.ok(emergencyAudioVerified.body.verificationToken);

    const unverifiedRegisterOptions = await request(baseUrl, '/api/passkey/register/options', { method: 'POST' }, cookie);
    assert.strictEqual(unverifiedRegisterOptions.res.status, 401);

    const emergencyRegisterOptions = await request(baseUrl, '/api/passkey/register/options', {
      method: 'POST',
      body: JSON.stringify({ registrationVerificationToken: emergencyAudioVerified.body.verificationToken }),
    }, emergencyAudioFallback.cookie);
    assert.strictEqual(emergencyRegisterOptions.res.status, 403);

    const livenessVerified = await request(baseUrl, '/api/liveness/verify', {
      method: 'POST',
      body: JSON.stringify({ durationMs: 1200, faceFrames: 10, motionScore: 0.12 }),
    }, cookie);
    assert.strictEqual(livenessVerified.res.status, 200);
    assert.ok(livenessVerified.body.verificationToken);

    const verifiedRegisterOptions = await request(baseUrl, '/api/passkey/register/options', {
      method: 'POST',
      body: JSON.stringify({ registrationVerificationToken: livenessVerified.body.verificationToken }),
    }, cookie);
    assert.strictEqual(verifiedRegisterOptions.res.status, 200);
    assert.ok(verifiedRegisterOptions.body.challenge);

    const noPasskey = await request(baseUrl, '/api/passkey/auth/options', { method: 'POST' }, cookie);
    assert.strictEqual(noPasskey.res.status, 409);

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

    console.log('server security regression tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
