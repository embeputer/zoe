const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN_TTL_MS = 2 * 60 * 1000;
const CHALLENGE_TTL_MS = 90 * 1000;
const MIN_STEP_DURATION_MS = 180;
const MAX_STEP_DURATION_MS = 12 * 1000;
const MIN_HOLD_FRAMES = 8;
const MAX_BODY_BYTES = 32 * 1024;
const ACCESSIBILITY_REQUEST_COOLDOWN_MS = 60 * 1000;
const FALLBACK_TTL_MS = 2 * 60 * 1000;
const FALLBACK_MAX_ATTEMPTS = 5;
const APP_NAME = 'Zoe';
const COOKIE_NAME = 'zoe_sid';
const SECRET = process.env.ZOE_SECRET || process.env.REALHANDS_SECRET || crypto.randomBytes(32).toString('hex');

const GESTURES = [
  { id: 'wave', name: 'Wave', emoji: '👋', hint: 'Open hand, move it side to side.' },
  { id: 'fist', name: 'Fist', emoji: '✊', hint: 'Close your hand into a fist.' },
  { id: 'open_palm', name: 'Open Palm', emoji: '🖐️', hint: 'Hold your open palm toward the camera.' },
  { id: 'peace', name: 'Peace Sign', emoji: '✌️', hint: 'Index and middle fingers up, others folded.' },
  { id: 'point', name: 'Pointing', emoji: '☝️', hint: 'Index finger up, others folded.' },
  { id: 'three', name: 'Three Fingers', emoji: '3️⃣', hint: 'Hold up index, middle, and ring fingers. Keep thumb and pinky folded.' },
  { id: 'ily', name: 'Hand Hearts', emoji: '💖', hint: 'Use both hands: touch your thumbs together and your index fingertips together.' },
  { id: 'rock', name: 'Rock', emoji: '🤘', hint: 'Index and pinky up, middle and ring folded (horns).' },
  { id: 'call_me', name: 'Call Me', emoji: '🤙', hint: 'Thumb and pinky out, other fingers folded (shaka).' },
  { id: 'ok', name: 'OK Sign', emoji: '👌', hint: 'Touch thumb and index into a ring, other fingers up.' },
];

const sessions = new Map();
const challenges = new Map();
const assistedRequests = new Map();
const fallbackChallenges = new Map();
const usedTokenDigests = new Set();

const WORDS = [
  'ember', 'signal', 'orbit', 'bright', 'steady', 'river',
  'hand', 'proof', 'window', 'silver', 'kind', 'north',
];

function now() {
  return Date.now();
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeAnswer(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hmac(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
}

function verifySignedPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!timingSafeEqual(hmac(parts[0]), parts[1])) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = new Map();
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || !rawValue.length) continue;
    out.set(rawName, decodeURIComponent(rawValue.join('=')));
  }
  return out;
}

function getSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies.get(COOKIE_NAME);
  if (!sid || !sessions.has(sid)) {
    sid = randomId(18);
    sessions.set(sid, {
      id: sid,
      createdAt: now(),
      lastSeenAt: now(),
      issuedTokens: new Map(),
      lastAccessibilityRequestAt: 0,
      emergencyVerifiedAt: 0,
      credentials: new Map(),
      passkeyRegisterChallenge: null,
      passkeyAuthChallenge: null,
    });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
  } else {
    sessions.get(sid).lastSeenAt = now();
  }
  return sessions.get(sid);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function shuffleGestures() {
  const pool = [...GESTURES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function publicStep(challenge) {
  const gesture = challenge.steps[challenge.currentStep];
  return {
    index: challenge.currentStep,
    id: gesture.id,
    name: gesture.name,
    emoji: gesture.emoji,
    hint: gesture.hint,
  };
}

function createChallenge(session) {
  const created = now();
  const challenge = {
    id: randomId(),
    sessionId: session.id,
    steps: shuffleGestures().slice(0, 3),
    currentStep: 0,
    createdAt: created,
    expiresAt: created + CHALLENGE_TTL_MS,
    consumedAt: null,
    stepStartedAt: created,
    evidenceDigests: new Set(),
  };
  challenges.set(challenge.id, challenge);
  return challenge;
}

function validateEvidence(challenge, body) {
  const evidence = body && body.evidence;
  if (!evidence || typeof evidence !== 'object') return 'Missing evidence.';
  if (body.challengeId !== challenge.id) return 'Challenge mismatch.';
  if (body.stepIndex !== challenge.currentStep) return 'Step is out of sequence.';
  const expectedGesture = challenge.steps[challenge.currentStep].id;
  if (body.gestureId !== expectedGesture) return 'Gesture does not match this challenge step.';

  const frameCount = Number(evidence.frameCount);
  const holdFrames = Number(evidence.holdFrames);
  const durationMs = Number(evidence.durationMs);
  const matchedAt = Number(evidence.matchedAt);
  const startedAt = Number(evidence.startedAt);
  if (!Number.isFinite(frameCount) || frameCount < MIN_HOLD_FRAMES) return 'Too few processed frames.';
  if (!Number.isFinite(holdFrames) || holdFrames < MIN_HOLD_FRAMES) return 'Gesture was not held long enough.';
  if (!Number.isFinite(durationMs) || durationMs < MIN_STEP_DURATION_MS || durationMs > MAX_STEP_DURATION_MS) {
    return 'Step timing is outside the allowed range.';
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(matchedAt) || matchedAt <= startedAt) return 'Invalid evidence timing.';

  const digest = crypto.createHash('sha256').update(JSON.stringify({
    challengeId: body.challengeId,
    stepIndex: body.stepIndex,
    gestureId: body.gestureId,
    frameCount,
    holdFrames,
    durationMs,
    landmarkDigest: String(evidence.landmarkDigest || ''),
    motionDigest: String(evidence.motionDigest || ''),
  })).digest('base64url');
  if (challenge.evidenceDigests.has(digest)) return 'Replay evidence was already submitted.';
  challenge.evidenceDigests.add(digest);
  return null;
}

function issueVerificationToken(session, source, method = 'gesture', assurance = 'standard') {
  const iat = now();
  const payload = {
    type: 'zoe.verification',
    sid: session.id,
    challengeId: source.id,
    action: 'demo.protected-action',
    method,
    assurance,
    nonce: randomId(16),
    iat,
    exp: iat + TOKEN_TTL_MS,
  };
  const token = signPayload(payload);
  session.issuedTokens.set(crypto.createHash('sha256').update(token).digest('base64url'), payload);
  return token;
}

function originAllowed(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

function decodeCredentialPart(value) {
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function parseClientData(value, expectedType, expectedChallenge) {
  const bytes = decodeCredentialPart(value);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.type !== expectedType) return null;
    if (parsed.challenge !== expectedChallenge) return null;
    if (!originAllowed(parsed.origin)) return null;
    return { parsed, bytes };
  } catch {
    return null;
  }
}

function createFallbackChallenge(session, mode) {
  const createdAt = now();
  let prompt;
  let speakText = null;
  let answer;

  if (mode === 'text') {
    const words = Array.from({ length: 3 }, () => WORDS[crypto.randomInt(WORDS.length)]);
    answer = words.join(' ');
    prompt = `Type these words: ${answer}`;
  } else if (mode === 'audio') {
    const code = Array.from({ length: 6 }, () => String(crypto.randomInt(10))).join('');
    answer = code;
    prompt = 'Type the six digits you hear.';
    speakText = code.split('').join(' ');
  } else if (mode === 'emergency_text') {
    const code = Array.from({ length: 4 }, () => String(crypto.randomInt(10))).join('');
    answer = `emergency ${code}`;
    prompt = `Emergency check: type "emergency ${code}" to continue once.`;
  } else if (mode === 'emergency_audio') {
    const code = Array.from({ length: 6 }, () => String(crypto.randomInt(10))).join('');
    answer = code;
    prompt = 'Emergency audio: type the six digits you hear.';
    speakText = code.split('').join(' ');
  } else {
    return null;
  }

  const challenge = {
    id: randomId(),
    sessionId: session.id,
    mode,
    prompt,
    speakText,
    answerHash: hmac(normalizeAnswer(answer)),
    attempts: 0,
    createdAt,
    expiresAt: createdAt + FALLBACK_TTL_MS,
    consumedAt: null,
  };
  fallbackChallenges.set(challenge.id, challenge);
  return challenge;
}

function verifyFallbackAnswer(challenge, answer) {
  if (challenge.consumedAt) return 'Challenge was already used.';
  if (now() > challenge.expiresAt) return 'Challenge expired.';
  if (challenge.attempts >= FALLBACK_MAX_ATTEMPTS) return 'Too many attempts.';
  challenge.attempts++;
  return timingSafeEqual(challenge.answerHash, hmac(normalizeAnswer(answer))) ? null : 'That answer did not match.';
}

function parseSignCount(authenticatorData) {
  if (!Buffer.isBuffer(authenticatorData) || authenticatorData.length < 37) return 0;
  return authenticatorData.readUInt32BE(33);
}

function verifyPasskeySignature(credential, authenticatorData, clientDataJSON, signature) {
  const clientHash = crypto.createHash('sha256').update(clientDataJSON).digest();
  const signedData = Buffer.concat([authenticatorData, clientHash]);
  const key = crypto.createPublicKey({
    key: Buffer.from(credential.publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const algorithm = credential.alg === -257 ? 'RSA-SHA256' : 'SHA256';
  return crypto.verify(algorithm, signedData, key, signature);
}

async function handleApi(req, res, pathname) {
  const session = getSession(req, res);

  if (req.method === 'POST' && pathname === '/api/challenge') {
    const challenge = createChallenge(session);
    return sendJson(res, 201, {
      challengeId: challenge.id,
      totalSteps: challenge.steps.length,
      expiresAt: challenge.expiresAt,
      step: publicStep(challenge),
    });
  }

  if (req.method === 'POST' && pathname === '/api/step') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const challenge = challenges.get(body.challengeId);
    if (!challenge || challenge.sessionId !== session.id) return sendJson(res, 404, { error: 'Unknown challenge.' });
    if (challenge.consumedAt) return sendJson(res, 409, { error: 'Challenge was already consumed.' });
    if (now() > challenge.expiresAt) return sendJson(res, 410, { error: 'Challenge expired.' });

    const evidenceError = validateEvidence(challenge, body);
    if (evidenceError) return sendJson(res, 400, { error: evidenceError });

    challenge.currentStep++;
    if (challenge.currentStep >= challenge.steps.length) {
      challenge.consumedAt = now();
      return sendJson(res, 200, {
        verified: true,
        verificationToken: issueVerificationToken(session, challenge, 'gesture', 'standard'),
        tokenExpiresAt: now() + TOKEN_TTL_MS,
      });
    }

    challenge.stepStartedAt = now();
    return sendJson(res, 200, {
      verified: false,
      challengeId: challenge.id,
      totalSteps: challenge.steps.length,
      expiresAt: challenge.expiresAt,
      step: publicStep(challenge),
    });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/register/options') {
    const challenge = randomId(32);
    session.passkeyRegisterChallenge = { challenge, createdAt: now() };
    return sendJson(res, 200, {
      challenge,
      rp: { name: APP_NAME },
      user: {
        id: session.id,
        name: `zoe-${session.id.slice(0, 8)}`,
        displayName: 'Zoe user',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: Array.from(session.credentials.keys()).map((id) => ({ type: 'public-key', id })),
    });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/reset') {
    session.credentials.clear();
    session.passkeyRegisterChallenge = null;
    session.passkeyAuthChallenge = null;
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/register/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const pending = session.passkeyRegisterChallenge;
    if (!pending || now() - pending.createdAt > FALLBACK_TTL_MS) return sendJson(res, 410, { error: 'Passkey registration expired.' });
    const client = parseClientData(body.clientDataJSON, 'webauthn.create', pending.challenge);
    if (!client) return sendJson(res, 400, { error: 'Passkey registration challenge did not verify.' });

    const rawId = typeof body.rawId === 'string' ? body.rawId : null;
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : null;
    const alg = Number(body.alg);
    if (!rawId || !publicKey || ![-7, -257].includes(alg)) {
      return sendJson(res, 400, { error: 'Browser did not provide a usable passkey public key.' });
    }

    session.credentials.set(rawId, {
      id: rawId,
      publicKey,
      alg,
      signCount: 0,
      createdAt: now(),
    });
    session.passkeyRegisterChallenge = null;
    return sendJson(res, 201, { ok: true, credentialId: rawId });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/auth/options') {
    if (!session.credentials.size) return sendJson(res, 409, { error: 'No passkey is registered in this session yet.' });
    const challenge = randomId(32);
    session.passkeyAuthChallenge = { challenge, createdAt: now() };
    return sendJson(res, 200, {
      challenge,
      timeout: 60000,
      userVerification: 'preferred',
      allowCredentials: Array.from(session.credentials.keys()).map((id) => ({ type: 'public-key', id })),
    });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/auth/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const pending = session.passkeyAuthChallenge;
    if (!pending || now() - pending.createdAt > FALLBACK_TTL_MS) return sendJson(res, 410, { error: 'Passkey challenge expired.' });
    const credential = session.credentials.get(body.rawId);
    if (!credential) return sendJson(res, 404, { error: 'Unknown passkey credential.' });

    const client = parseClientData(body.clientDataJSON, 'webauthn.get', pending.challenge);
    const authenticatorData = decodeCredentialPart(body.authenticatorData);
    const signature = decodeCredentialPart(body.signature);
    if (!client || !authenticatorData || !signature) return sendJson(res, 400, { error: 'Passkey response was incomplete.' });
    if (!verifyPasskeySignature(credential, authenticatorData, client.bytes, signature)) {
      return sendJson(res, 401, { error: 'Passkey signature did not verify.' });
    }

    const signCount = parseSignCount(authenticatorData);
    if (credential.signCount && signCount && signCount <= credential.signCount) {
      return sendJson(res, 401, { error: 'Passkey replay was detected.' });
    }
    credential.signCount = signCount || credential.signCount;
    session.passkeyAuthChallenge = null;
    const token = issueVerificationToken(session, { id: `passkey:${credential.id}` }, 'passkey', 'strong');
    return sendJson(res, 200, { verified: true, verificationToken: token, tokenExpiresAt: now() + TOKEN_TTL_MS });
  }

  if (req.method === 'POST' && pathname === '/api/fallback/challenge') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const mode = ['emergency_text', 'emergency_audio'].includes(body.mode) ? body.mode : null;
    if (mode && mode.startsWith('emergency_') && session.emergencyVerifiedAt) {
      return sendJson(res, 429, { error: 'Emergency verification was already used in this session.' });
    }
    const challenge = mode ? createFallbackChallenge(session, mode) : null;
    if (!challenge) return sendJson(res, 400, { error: 'Unknown fallback mode.' });
    return sendJson(res, 201, {
      challengeId: challenge.id,
      mode: challenge.mode,
      prompt: challenge.prompt,
      speakText: challenge.speakText,
      expiresAt: challenge.expiresAt,
    });
  }

  if (req.method === 'POST' && pathname === '/api/fallback/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const challenge = fallbackChallenges.get(body.challengeId);
    if (!challenge || challenge.sessionId !== session.id) return sendJson(res, 404, { error: 'Unknown fallback challenge.' });
    const answerError = verifyFallbackAnswer(challenge, body.answer);
    if (answerError) return sendJson(res, 400, { error: answerError });
    if (challenge.mode.startsWith('emergency_') && session.emergencyVerifiedAt) {
      return sendJson(res, 429, { error: 'Emergency verification was already used in this session.' });
    }
    challenge.consumedAt = now();
    if (challenge.mode.startsWith('emergency_')) session.emergencyVerifiedAt = now();
    const assurance = challenge.mode.startsWith('emergency_') ? 'emergency' : 'fallback';
    const token = issueVerificationToken(session, challenge, challenge.mode, assurance);
    return sendJson(res, 200, {
      verified: true,
      verificationToken: token,
      tokenExpiresAt: now() + TOKEN_TTL_MS,
    });
  }

  if (req.method === 'POST' && pathname === '/api/liveness/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const durationMs = Number(body.durationMs);
    const faceFrames = Number(body.faceFrames);
    const motionScore = Number(body.motionScore);
    if (!Number.isFinite(durationMs) || durationMs < 900 || durationMs > 15000) {
      return sendJson(res, 400, { error: 'Face check timing is outside the allowed range.' });
    }
    if (!Number.isFinite(faceFrames) || faceFrames < 8) return sendJson(res, 400, { error: 'Face was not visible for long enough.' });
    if (!Number.isFinite(motionScore) || motionScore < 0.08) return sendJson(res, 400, { error: 'Face motion was too small to count as liveness.' });

    const token = issueVerificationToken(session, { id: `face:${randomId(12)}` }, 'face-motion', 'fallback');
    return sendJson(res, 200, {
      verified: true,
      verificationToken: token,
      tokenExpiresAt: now() + TOKEN_TTL_MS,
    });
  }

  if (req.method === 'POST' && pathname === '/api/accessibility-request') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    if (now() - session.lastAccessibilityRequestAt < ACCESSIBILITY_REQUEST_COOLDOWN_MS) {
      return sendJson(res, 429, { error: 'An assisted verification request is already open.' });
    }

    const requestId = `RH-${randomId(8).toUpperCase()}`;
    session.lastAccessibilityRequestAt = now();
    assistedRequests.set(requestId, {
      id: requestId,
      sessionId: session.id,
      challengeId: typeof body.challengeId === 'string' ? body.challengeId : null,
      completedSteps: Number.isFinite(Number(body.completedSteps)) ? Number(body.completedSteps) : 0,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 80) : 'accessibility_or_camera',
      createdAt: now(),
      status: 'pending_assisted_review',
    });

    return sendJson(res, 202, {
      requestId,
      status: 'pending_assisted_review',
      message: 'Assisted verification requested. This does not grant automatic access.',
    });
  }

  if (req.method === 'POST' && pathname === '/api/protected-action') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const payload = verifySignedPayload(body.verificationToken);
    if (!payload || payload.type !== 'zoe.verification') return sendJson(res, 401, { error: 'Invalid verification token.' });
    if (payload.sid !== session.id) return sendJson(res, 403, { error: 'Token is not bound to this session.' });
    if (payload.action !== 'demo.protected-action') return sendJson(res, 403, { error: 'Token is not valid for this action.' });
    if (now() > payload.exp) return sendJson(res, 401, { error: 'Verification token expired.' });

    const digest = crypto.createHash('sha256').update(body.verificationToken).digest('base64url');
    if (usedTokenDigests.has(digest)) return sendJson(res, 409, { error: 'Verification token was already used.' });
    if (!session.issuedTokens.has(digest)) return sendJson(res, 403, { error: 'Token was not issued to this session.' });

    usedTokenDigests.add(digest);
    session.issuedTokens.delete(digest);
    return sendJson(res, 200, { ok: true, message: 'Protected action accepted by the server.' });
  }

  return sendJson(res, 404, { error: 'Unknown API route.' });
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(__dirname, `.${requested}`);
  if (!filePath.startsWith(__dirname) || !['.html', '.css', '.js'].includes(path.extname(filePath))) {
    securityHeaders(res);
    res.writeHead(404);
    return res.end('Not found');
  }

  fs.readFile(filePath, (err, data) => {
    securityHeaders(res);
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url.pathname).catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: 'Internal server error.' });
      });
      return;
    }
    serveStatic(req, res, url.pathname);
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Zoe server listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { createServer };
