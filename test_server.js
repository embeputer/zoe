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
