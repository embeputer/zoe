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
const COOKIE_NAME = 'rh_sid';
const SECRET = process.env.REALHANDS_SECRET || crypto.randomBytes(32).toString('hex');

const GESTURES = [
  { id: 'wave', name: 'Wave', emoji: '👋', hint: 'Open hand, move it side to side.' },
  { id: 'fist', name: 'Fist', emoji: '✊', hint: 'Close your hand into a fist.' },
  { id: 'open_palm', name: 'Open Palm', emoji: '🖐️', hint: 'Hold your open palm toward the camera.' },
  { id: 'peace', name: 'Peace Sign', emoji: '✌️', hint: 'Index and middle fingers up, others folded.' },
  { id: 'point', name: 'Pointing', emoji: '☝️', hint: 'Index finger up, others folded.' },
  { id: 'three', name: 'Three', emoji: '🤟', hint: 'Thumb, index, and middle fingers up, ring and pinky folded.' },
  { id: 'ily', name: 'Hand Hearts', emoji: '💖', hint: 'Touch your thumb tips and index tips together to form a heart shape.' },
  { id: 'rock', name: 'Rock', emoji: '🤘', hint: 'Index and pinky up, middle and ring folded (horns).' },
  { id: 'call_me', name: 'Call Me', emoji: '🤙', hint: 'Thumb and pinky out, other fingers folded (shaka).' },
  { id: 'ok', name: 'OK Sign', emoji: '👌', hint: 'Touch thumb and index into a ring, other fingers up.' },
];

const sessions = new Map();
const challenges = new Map();
const assistedRequests = new Map();
const usedTokenDigests = new Set();

function now() {
  return Date.now();
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
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

function issueVerificationToken(session, challenge) {
  const iat = now();
  const payload = {
    type: 'realhands.verification',
    sid: session.id,
    challengeId: challenge.id,
    action: 'demo.protected-action',
    nonce: randomId(16),
    iat,
    exp: iat + TOKEN_TTL_MS,
  };
  const token = signPayload(payload);
  session.issuedTokens.set(crypto.createHash('sha256').update(token).digest('base64url'), payload);
  return token;
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
        verificationToken: issueVerificationToken(session, challenge),
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
    if (!payload || payload.type !== 'realhands.verification') return sendJson(res, 401, { error: 'Invalid verification token.' });
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
    const cacheControl = path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': cacheControl });
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
    console.log(`RealHands server listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { createServer };
