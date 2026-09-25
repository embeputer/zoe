const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  computePresentationDigest,
  computeFlashDigest,
  validatePresentationFrames,
  validateFlashFrames,
  analyzePresentationFrames,
  faceSignals,
} = require('./face_pad');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REQUIRE_SECRET = IS_PRODUCTION || process.env.ZOE_REQUIRE_SECRET === '1';
const LOG_VERIFICATION_FAILURES = process.env.ZOE_LOG_VERIFICATION_FAILURES === '1';
const RATE_LIMIT_WINDOW_MS = Number(process.env.ZOE_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_PER_IP = Number(process.env.ZOE_RATE_LIMIT_MAX_PER_IP || 120);
// Per-session cap on API hits per window, on top of the per-IP cap. Read
// per-request (like the wall-clock floors) so tests and ops can toggle it.
function rateLimitMaxPerSession() {
  return Number(process.env.ZOE_RATE_LIMIT_MAX_PER_SESSION ?? 60);
}
const SESSION_IDLE_TTL_MS = Number(process.env.ZOE_SESSION_IDLE_TTL_MS || 60 * 60 * 1000);
const SWEEP_MIN_INTERVAL_MS = Number(process.env.ZOE_SWEEP_INTERVAL_MS || 30_000);
const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3000',
  'http://localhost:3001',
];
const ALLOWED_ORIGINS = (process.env.ZOE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const ALLOWED_ORIGIN_SET = new Set(ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS);
const STATE_CHANGING_POST_PATHS = new Set([
  '/api/challenge',
  '/api/step',
  '/api/liveness/challenge',
  '/api/liveness/verify',
  '/api/passkey/register/options',
  '/api/passkey/register/verify',
  '/api/passkey/auth/options',
  '/api/passkey/auth/verify',
  '/api/passkey/reset',
  '/api/protected-action',
  '/api/verify',
]);
const TOKEN_TTL_MS = 2 * 60 * 1000;
const CHALLENGE_TTL_MS = 90 * 1000;
const MIN_STEP_DURATION_MS = 180;
const MAX_STEP_DURATION_MS = 12 * 1000;
const MIN_HOLD_FRAMES = 8;
const LIVENESS_CHALLENGE_TTL_MS = 150 * 1000;
const LIVENESS_TRANSITION_MS_MIN = 150;
const LIVENESS_TRANSITION_MS_MAX = 14 * 1000;
const LIVENESS_HOLD_JITTER_MIN = 0.00035;
const LIVENESS_TRANSITION_JITTER_MIN = 0.00035;
const LIVENESS_TORTUOSITY_MIN = 1.004;
const LIVENESS_SYNTHETIC_JITTER_MAX = 0.00015;
const LIVENESS_SYNTHETIC_TORTUOSITY_MAX = 1.003;
const HAND_FORMING_VAR_MIN = 1e-7;
const HAND_HOLD_JITTER_MIN = 1e-5;
const MAX_LANDMARK_SAMPLES = 24;
const MAX_MOTION_SERIES = 120;
const LIVENESS_PLAN_LEFT_FIRST = ['center_hold', 'center_to_left', 'left_to_right'];
const LIVENESS_PLAN_RIGHT_FIRST = ['center_hold', 'center_to_right', 'right_to_left'];
const MAX_BODY_BYTES = 128 * 1024;
const MAX_LIVENESS_BODY_BYTES = 640 * 1024;
const FLASH_FACE_PIXEL_BYTES = 12 * 9 * 3;
const FLASH_BG_PIXEL_BYTES = 4 * 1 * 3;
const MAX_PIXEL_SAMPLES = 140;
const FLASH_COUNT = 4;
const FLASH_LEAD_MS = 900;
// Photosensitivity safety (WCAG-style): a flash cycle is at least ~1.1s, so
// the sequence stays under one flash/second — well clear of the >3/second
// risk band — and reduced-motion users skip the plan entirely.
const FLASH_DURATION_MIN_MS = 650;
const FLASH_DURATION_SPAN_MS = 150;
const FLASH_GAP_MIN_MS = 460;
const FLASH_GAP_SPAN_MS = 180;
const FLASH_BASELINE_LEAD_MS = 100;
const FLASH_RESPONSE_LEAD_MS = 80;
const FLASH_LAG_SLACK_MS = 120;
const FLASH_MIN_BASELINE_SAMPLES = 3;
const FLASH_MIN_SAMPLES_PER_FLASH = 2;
const FLASH_CHROMA_COSINE_MIN = 0.6;
const FLASH_CHROMA_RATIO_MIN = 0.025;
const FLASH_CHROMA_RATIO_MAX = 2;
const FLASH_NOISE_L1_MIN = 0.3;
const FLASH_NOISE_L1_MAX = 90;
const FLASH_DISTINCT_FRAMES_MIN = 0.6;

const PULSE_MIN_SAMPLES = 90;
const PULSE_MAX_SAMPLES = 400;
const PULSE_MIN_SPAN_MS = 9000;
// reducedMotion skips the flash gate entirely, so the pulse check alone must
// carry more evidence: a longer measurement window is required instead.
const PULSE_REDUCED_MIN_SPAN_MS = 18000;
const PULSE_MIN_HZ = 0.8;
const PULSE_MAX_HZ = 2.4;
const PULSE_STD_MIN = 0.4;
const PULSE_PEAK_RATIO_MIN = 3;
const PULSE_LOBE_BINS = 5;
// A real pulse concentrates a solid share of band power in the peak's main
// lobe (±5 bins ≈ ±0.125Hz) but not all of it: white noise spreads too thin,
// a clean injected sine concentrates ~everything. Both bounds reject fakes.
const PULSE_LOBE_FRACTION_MIN = 0.45;
const PULSE_LOBE_FRACTION_MAX = 0.97;
const PASSKEY_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const APP_NAME = 'Zoe';
const COOKIE_NAME = 'zoe_sid';

function resolveSecret() {
  const fromEnv = process.env.ZOE_SECRET;
  if (fromEnv) return fromEnv;
  if (REQUIRE_SECRET) {
    console.error('ZOE_SECRET is required when NODE_ENV=production or ZOE_REQUIRE_SECRET=1.');
    process.exit(1);
  }
  if (!resolveSecret.warned) {
    console.warn('Zoe: using an ephemeral ZOE_SECRET; set ZOE_SECRET for stable tokens across restarts.');
    resolveSecret.warned = true;
  }
  return crypto.randomBytes(32).toString('hex');
}

const SECRET = resolveSecret();

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
const usedTokenDigests = new Set();
const rateLimitByIp = new Map();
const rateLimitBySession = new Map();
let lastSweepAt = 0;

// Durable state: sessions, passkey credentials, and consumed token digests
// survive restarts. Short-lived challenge state stays in memory on purpose.
const DB_PATH = process.env.ZOE_DB_PATH || path.join(__dirname, 'zoe-data.sqlite3');
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    alg INTEGER NOT NULL,
    sign_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    hardware_backed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, id)
  );
  CREATE TABLE IF NOT EXISTS used_tokens (
    digest TEXT PRIMARY KEY,
    used_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issued_tokens (
    digest TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    exp INTEGER NOT NULL
  );
`);
try {
  db.exec('ALTER TABLE credentials ADD COLUMN hardware_backed INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists on pre-upgrade databases.
}

for (const row of db.prepare('SELECT id, created_at, last_seen_at FROM sessions').all()) {
  sessions.set(row.id, {
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    issuedTokens: new Map(),
    credentials: new Map(),
    passkeyRegisterChallenges: new Map(),
    passkeyAuthChallenges: new Map(),
    livenessChallenge: null,
    persisted: true,
  });
}
for (const row of db.prepare('SELECT session_id, id, public_key, alg, sign_count, created_at, hardware_backed FROM credentials').all()) {
  const session = sessions.get(row.session_id);
  if (session) {
    session.credentials.set(row.id, {
      id: row.id,
      publicKey: row.public_key,
      alg: row.alg,
      signCount: row.sign_count,
      createdAt: row.created_at,
      hardwareBacked: row.hardware_backed === 1,
    });
  }
}
for (const row of db.prepare('SELECT digest FROM used_tokens').all()) {
  usedTokenDigests.add(row.digest);
}

const persistSessionStmt = db.prepare('INSERT OR REPLACE INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)');
const persistCredentialStmt = db.prepare('INSERT OR REPLACE INTO credentials (session_id, id, public_key, alg, sign_count, created_at, hardware_backed) VALUES (?, ?, ?, ?, ?, ?, ?)');
const persistUsedTokenStmt = db.prepare('INSERT OR IGNORE INTO used_tokens (digest, used_at) VALUES (?, ?)');
const persistIssuedTokenStmt = db.prepare('INSERT OR REPLACE INTO issued_tokens (digest, session_id, payload_json, exp) VALUES (?, ?, ?, ?)');
const getIssuedTokenStmt = db.prepare('SELECT session_id, payload_json, exp FROM issued_tokens WHERE digest = ?');
const deleteIssuedTokenStmt = db.prepare('DELETE FROM issued_tokens WHERE digest = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteSessionCredentialsStmt = db.prepare('DELETE FROM credentials WHERE session_id = ?');
const deleteSessionIssuedTokensStmt = db.prepare('DELETE FROM issued_tokens WHERE session_id = ?');
const pruneUsedTokensStmt = db.prepare('DELETE FROM used_tokens WHERE used_at < ?');
const pruneIssuedTokensStmt = db.prepare('DELETE FROM issued_tokens WHERE exp < ?');

function persistSession(session) {
  persistSessionStmt.run(session.id, session.createdAt, session.lastSeenAt);
  session.persisted = true;
}

function persistCredential(sessionId, credential) {
  persistCredentialStmt.run(sessionId, credential.id, credential.publicKey, credential.alg, credential.signCount, credential.createdAt, credential.hardwareBacked ? 1 : 0);
}

function persistUsedToken(digest) {
  persistUsedTokenStmt.run(digest, now());
}

// Issued-token digests persist so redemption survives a restart: the in-memory
// session.issuedTokens map is the fast path, this table is the fallback when
// the session entry was reloaded without its issued tokens.
function persistIssuedToken(digest, sessionId, payload) {
  persistIssuedTokenStmt.run(digest, sessionId, JSON.stringify(payload), payload.exp);
}

function getIssuedToken(digest) {
  const row = getIssuedTokenStmt.get(digest);
  if (!row) return null;
  if (now() > row.exp) {
    deleteIssuedToken(digest);
    return null;
  }
  let payload = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return { sessionId: row.session_id, payload, exp: row.exp };
}

function deleteIssuedToken(digest) {
  deleteIssuedTokenStmt.run(digest);
}

function deletePersistedSession(sessionId) {
  deleteSessionStmt.run(sessionId);
  deleteSessionCredentialsStmt.run(sessionId);
  deleteSessionIssuedTokensStmt.run(sessionId);
}

function now() {
  return Date.now();
}

// Wall-clock floors: the pulse stage always takes >=14s of real time and each
// gesture step takes >=180ms, so a verification that claims seconds of camera
// evidence cannot mint in milliseconds. Read per-request so tests can shorten.
function livenessMinElapsedMs() {
  return Number(process.env.ZOE_LIVENESS_MIN_ELAPSED_MS ?? 14000);
}
// Reduced-motion challenges skip the flash stage but measure pulse longer.
function reducedMotionMinElapsedMs() {
  return Number(process.env.ZOE_REDUCED_MOTION_MIN_ELAPSED_MS ?? 19000);
}
function stepMinElapsedMs() {
  return Number(process.env.ZOE_STEP_MIN_ELAPSED_MS ?? MIN_STEP_DURATION_MS);
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function originAllowed(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  const normalized = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  if (ALLOWED_ORIGIN_SET.has(origin) || ALLOWED_ORIGIN_SET.has(normalized)) return true;
  if (!IS_PRODUCTION) {
    try {
      const url = new URL(normalized);
      return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    } catch {
      return false;
    }
  }
  return false;
}

function validateStateChangingOrigin(req) {
  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  let candidate = typeof originHeader === 'string' && originHeader ? originHeader : null;
  if (!candidate && typeof refererHeader === 'string' && refererHeader) {
    try {
      candidate = new URL(refererHeader).origin;
    } catch {
      candidate = null;
    }
  }
  if (candidate && originAllowed(candidate)) return { ok: true };
  if (!IS_PRODUCTION) {
    if (!candidate) return { ok: true };
  }
  if (!candidate) return { ok: false, error: 'Missing Origin or Referer header.' };
  return { ok: false, error: 'Origin is not allowed.' };
}

function checkRateLimit(ip, sessionId) {
  const t = now();
  let ipBucket = rateLimitByIp.get(ip);
  if (!ipBucket || t >= ipBucket.resetAt) {
    ipBucket = { count: 0, resetAt: t + RATE_LIMIT_WINDOW_MS };
    rateLimitByIp.set(ip, ipBucket);
  }
  ipBucket.count += 1;
  if (ipBucket.count > RATE_LIMIT_MAX_PER_IP) {
    return { limited: true, scope: 'ip' };
  }

  const sessionMax = rateLimitMaxPerSession();
  if (sessionMax > 0 && sessionId) {
    let sessionBucket = rateLimitBySession.get(sessionId);
    if (!sessionBucket || t >= sessionBucket.resetAt) {
      sessionBucket = { count: 0, resetAt: t + RATE_LIMIT_WINDOW_MS };
      rateLimitBySession.set(sessionId, sessionBucket);
    }
    sessionBucket.count += 1;
    if (sessionBucket.count > sessionMax) {
      return { limited: true, scope: 'session' };
    }
  }

  return { limited: false };
}

function resetRateLimitState() {
  rateLimitByIp.clear();
  rateLimitBySession.clear();
}

function logVerificationFailure(reasonCode, route) {
  if (!LOG_VERIFICATION_FAILURES) return;
  console.log(JSON.stringify({ event: 'verification_failure', reason: reasonCode, route }));
}

function sweepExpiredState(force = false) {
  const t = now();
  if (!force && t - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = t;

  for (const [challengeId, challenge] of challenges) {
    const expired = t > challenge.expiresAt;
    const staleConsumed = challenge.consumedAt && t - challenge.consumedAt > CHALLENGE_TTL_MS;
    if (expired || staleConsumed) challenges.delete(challengeId);
  }

  pruneUsedTokensStmt.run(t - TOKEN_TTL_MS);
  pruneIssuedTokensStmt.run(t);
  for (const [ip, bucket] of rateLimitByIp) {
    if (t >= bucket.resetAt) rateLimitByIp.delete(ip);
  }
  for (const [sid, bucket] of rateLimitBySession) {
    if (t >= bucket.resetAt) rateLimitBySession.delete(sid);
  }
  for (const [sid, session] of sessions) {
    if (t - session.lastSeenAt > SESSION_IDLE_TTL_MS) {
      sessions.delete(sid);
      deletePersistedSession(sid);
      continue;
    }
    for (const [digest, payload] of session.issuedTokens) {
      if (t > payload.exp) session.issuedTokens.delete(digest);
    }
    for (const [challenge, pending] of session.passkeyRegisterChallenges) {
      if (t - pending.createdAt > PASSKEY_CHALLENGE_TTL_MS) session.passkeyRegisterChallenges.delete(challenge);
    }
    for (const [challenge, pending] of session.passkeyAuthChallenges) {
      if (t - pending.createdAt > PASSKEY_CHALLENGE_TTL_MS) session.passkeyAuthChallenges.delete(challenge);
    }
    if (session.livenessChallenge && t > session.livenessChallenge.expiresAt) {
      session.livenessChallenge = null;
    }
  }
}

function enforcePostSecurity(req, res, pathname, sessionId) {
  if (req.method !== 'POST' || !STATE_CHANGING_POST_PATHS.has(pathname)) return true;

  // /api/verify is the relying-party redemption endpoint: the caller is a
  // backend redeeming a bearer token, not the verified browser session, so
  // browser-origin rules do not apply (the token itself is the credential).
  const originCheck = pathname === '/api/verify' ? { ok: true } : validateStateChangingOrigin(req);
  if (!originCheck.ok) {
    logVerificationFailure('origin_rejected', pathname);
    sendJson(res, 403, { error: originCheck.error });
    return false;
  }

  const rateLimit = checkRateLimit(clientIp(req), sessionId);
  if (rateLimit.limited) {
    sendJson(res, 429, {
      error: 'Too many requests. Please slow down and try again.',
      rateLimitScope: rateLimit.scope,
    });
    return false;
  }

  return true;
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
    try {
      out.set(rawName, decodeURIComponent(rawValue.join('=')));
    } catch {
      // Skip malformed percent-encoding instead of throwing.
    }
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
      credentials: new Map(),
      passkeyRegisterChallenges: new Map(),
      passkeyAuthChallenges: new Map(),
      livenessChallenge: null,
      persisted: false,
    });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secureCookieSuffix(req)}`);
  } else {
    const session = sessions.get(sid);
    session.lastSeenAt = now();
    // Anonymous hits create memory-only sessions; a row is written only once
    // the session stores real state (challenge, credential, token).
    if (session.persisted) persistSession(session);
  }
  return sessions.get(sid);
}

function secureCookieSuffix(req) {
  const forwardedHttps = req.headers['x-forwarded-proto'] === 'https';
  const tlsSocket = Boolean(req.socket && req.socket.encrypted);
  return forwardedHttps || tlsSocket || process.env.ZOE_SECURE_COOKIES === '1' ? '; Secure' : '';
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
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
  persistSession(session);
  return challenge;
}

function validateEvidence(challenge, body) {
  const evidence = body && body.evidence;
  if (!evidence || typeof evidence !== 'object') return 'Missing evidence.';
  if (body.challengeId !== challenge.id) return 'Challenge mismatch.';
  if (body.stepIndex !== challenge.currentStep) return 'Step is out of sequence.';
  const expectedGesture = challenge.steps[challenge.currentStep].id;
  if (body.gestureId !== expectedGesture) return 'Gesture does not match this challenge step.';

  const frameCount = evidence.frameCount;
  const holdFrames = evidence.holdFrames;
  const durationMs = evidence.durationMs;
  const matchedAt = evidence.matchedAt;
  const startedAt = evidence.startedAt;
  if (typeof frameCount !== 'number' || !Number.isFinite(frameCount) || frameCount < MIN_HOLD_FRAMES) return 'Too few processed frames.';
  if (typeof holdFrames !== 'number' || !Number.isFinite(holdFrames) || holdFrames < MIN_HOLD_FRAMES) return 'Gesture was not held long enough.';
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < MIN_STEP_DURATION_MS || durationMs > MAX_STEP_DURATION_MS) {
    return 'Step timing is outside the allowed range.';
  }
  if (typeof startedAt !== 'number' || typeof matchedAt !== 'number' || !Number.isFinite(startedAt) || !Number.isFinite(matchedAt) || matchedAt <= startedAt) return 'Invalid evidence timing.';

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

  const motionStats = evidence.motionStats;
  if (motionStats && typeof motionStats === 'object') {
    const formingMotion = Number(motionStats.formingMotion);
    const holdJitterRms = Number(motionStats.holdJitterRms);
    if (Number.isFinite(formingMotion) && formingMotion < HAND_FORMING_VAR_MIN) {
      return 'Hand motion while forming the gesture was too static.';
    }
    if (Number.isFinite(holdJitterRms) && holdJitterRms < HAND_HOLD_JITTER_MIN) {
      return 'Hand hold looked unnaturally steady.';
    }
  }

  const landmarkSamples = evidence.landmarkSamples;
  if (landmarkSamples !== undefined) {
    const geometryError = validateHandLandmarkGeometry(expectedGesture, landmarkSamples);
    if (geometryError) return geometryError;
  }

  challenge.evidenceDigests.add(digest);
  return null;
}

function createLivenessPlan() {
  return crypto.randomInt(2) === 0 ? [...LIVENESS_PLAN_LEFT_FIRST] : [...LIVENESS_PLAN_RIGHT_FIRST];
}

const FLASH_COLORS = [
  [255, 64, 64],
  [64, 160, 255],
  [60, 220, 60],
  [255, 190, 60],
  [180, 60, 255],
  [60, 220, 220],
];

// A per-challenge random screen-flash sequence: the screen lights the user's
// face and the client uploads timestamped face-region pixels, so the server
// can check reflected light tracks a stimulus only this session knew.
function createFlashPlan() {
  const colors = [...FLASH_COLORS];
  for (let i = colors.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  let onset = FLASH_LEAD_MS;
  return colors.slice(0, FLASH_COUNT).map((color) => {
    const durationMs = FLASH_DURATION_MIN_MS + crypto.randomInt(FLASH_DURATION_SPAN_MS + 1);
    const flash = { c: color, o: onset, d: durationMs };
    onset += durationMs + FLASH_GAP_MIN_MS + crypto.randomInt(FLASH_GAP_SPAN_MS + 1);
    return flash;
  });
}

function pixelMeanChannels(buffers) {
  const acc = [0, 0, 0];
  let count = 0;
  for (const buf of buffers) {
    for (let i = 0; i + 2 < buf.length; i += 3) {
      acc[0] += buf[i];
      acc[1] += buf[i + 1];
      acc[2] += buf[i + 2];
    }
    count += buf.length / 3;
  }
  return acc.map((v) => v / Math.max(1, count));
}

function channelChromaticity(channels) {
  const sum = channels.reduce((total, value) => total + Math.max(0, value), 0);
  if (sum < 1e-6) return [0, 0, 0];
  return channels.map((value) => Math.max(0, value) / sum);
}

function decodePixelField(value, expectedBytes) {
  if (typeof value !== 'string') return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length === expectedBytes ? buf : null;
}

function validatePixelSeries(pixelSeries, flashPlan) {
  if (!Array.isArray(flashPlan) || !flashPlan.length) return 'Flash liveness plan is missing.';
  if (!Array.isArray(pixelSeries) || pixelSeries.length < 8 || pixelSeries.length > MAX_PIXEL_SAMPLES) {
    return 'Pixel liveness series is invalid.';
  }

  const samples = [];
  let lastT = -1;
  for (const sample of pixelSeries) {
    const t = Number(sample && sample.t);
    if (!Number.isFinite(t) || t < 0 || t > 30000 || t < lastT) return 'Pixel sample timing is invalid.';
    lastT = t;
    const entry = { t };
    if (sample.f !== undefined) {
      const f = decodePixelField(sample.f, FLASH_FACE_PIXEL_BYTES);
      if (!f) return 'Pixel sample face data is invalid.';
      entry.f = f;
    }
    samples.push(entry);
  }

  const firstOnset = flashPlan[0].o;
  const lastEnd = flashPlan[flashPlan.length - 1].o + flashPlan[flashPlan.length - 1].d;
  if (samples[samples.length - 1].t < lastEnd - 40) return 'Pixel samples do not cover the flash sequence.';

  const baselineSamples = samples.filter((s) => s.f && s.t < firstOnset - FLASH_BASELINE_LEAD_MS);
  if (baselineSamples.length < FLASH_MIN_BASELINE_SAMPLES) return 'Pixel baseline before the flash sequence is too sparse.';
  const baseline = pixelMeanChannels(baselineSamples.map((s) => s.f));

  // Baseline frames must carry real sensor noise: identical consecutive frames
  // or zero temporal variation is a synthesized stream, not a camera.
  let l1Sum = 0;
  let differing = 0;
  for (let i = 1; i < baselineSamples.length; i++) {
    const prev = baselineSamples[i - 1].f;
    const cur = baselineSamples[i].f;
    let diff = 0;
    let any = false;
    for (let j = 0; j < cur.length; j++) {
      const d = Math.abs(cur[j] - prev[j]);
      diff += d;
      if (d) any = true;
    }
    l1Sum += diff / cur.length;
    if (any) differing += 1;
  }
  const meanL1 = l1Sum / (baselineSamples.length - 1);
  if (meanL1 < FLASH_NOISE_L1_MIN || meanL1 > FLASH_NOISE_L1_MAX) {
    return 'Pixel stream does not look like real camera noise.';
  }
  if (differing / (baselineSamples.length - 1) < FLASH_DISTINCT_FRAMES_MIN) {
    return 'Pixel stream repeats identical frames.';
  }

  const baselineChroma = channelChromaticity(baseline);
  for (const flash of flashPlan) {
    const expected = flash.c;
    const window = samples.filter((s) => (
      s.f
      && s.t >= flash.o + FLASH_RESPONSE_LEAD_MS
      && s.t <= flash.o + flash.d + FLASH_LAG_SLACK_MS
    ));
    if (window.length < FLASH_MIN_SAMPLES_PER_FLASH) return 'Pixel sampling missed a flash window.';
    const observed = pixelMeanChannels(window.map((s) => s.f));
    const observedChroma = channelChromaticity(observed);
    const expectedChroma = channelChromaticity(expected);
    const delta = observedChroma.map((v, i) => v - baselineChroma[i]);
    const expectedDelta = expectedChroma.map((v) => v - (1 / 3));
    const deltaMag = Math.hypot(...delta);
    const expectedMag = Math.hypot(...expectedDelta);
    const cosine = deltaMag > 1e-6 && expectedMag > 1e-6
      ? delta.reduce((sum, v, i) => sum + v * expectedDelta[i], 0) / (deltaMag * expectedMag)
      : 0;
    const ratio = deltaMag / expectedMag;
    if (cosine < FLASH_CHROMA_COSINE_MIN || ratio < FLASH_CHROMA_RATIO_MIN || ratio > FLASH_CHROMA_RATIO_MAX) {
      return 'Face pixels did not reflect the issued flash sequence.';
    }
  }
  return null;
}

// rPPG pulse check: detrended green-channel means sampled over a forehead ROI
// should hold a spectral peak in the physiologic band (48-144 BPM) — strong
// enough to be a real signal, but spread enough not to be a clean injected
// sine wave. Returns { bpm } on success or { error } on rejection.
function validatePulseSeries(pulseSeries, reducedMotion) {
  const minSpanMs = reducedMotion === true ? PULSE_REDUCED_MIN_SPAN_MS : PULSE_MIN_SPAN_MS;
  if (!Array.isArray(pulseSeries) || pulseSeries.length < PULSE_MIN_SAMPLES || pulseSeries.length > PULSE_MAX_SAMPLES) {
    return { error: 'Pulse series is invalid.' };
  }
  const sig = [];
  let lastT = -1;
  for (const s of pulseSeries) {
    const g = Number(s && s.g);
    const t = Number(s && s.t);
    if (!Number.isFinite(g) || g < 0 || g > 255) return { error: 'Pulse samples are invalid.' };
    if (!Number.isFinite(t) || t < 0 || t > 120000 || t < lastT) return { error: 'Pulse sample timing is invalid.' };
    lastT = t;
    sig.push({ g, t });
  }
  const span = sig[sig.length - 1].t - sig[0].t;
  if (span < minSpanMs) return { error: 'Pulse measurement was too short.' };

  // Clients collect pulse samples in the background during the motion phases
  // too; those are noisier, so the spectral checks run on the stillness tail
  // (the dedicated hold-still segment the client appends last).
  const tailStart = sig[sig.length - 1].t - minSpanMs;
  const tail = sig.filter((s) => s.t >= tailStart);
  const win = tail.length >= PULSE_MIN_SAMPLES ? tail : sig;

  const mean = win.reduce((a, s) => a + s.g, 0) / win.length;
  const xs = win.map((s) => s.g - mean);
  const std = Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / win.length);
  if (std < PULSE_STD_MIN) return { error: 'Pulse signal was flat — no living tissue detected.' };

  // Median sample interval gives the effective sample rate.
  const dts = [];
  for (let i = 1; i < win.length; i++) dts.push(win[i].t - win[i - 1].t);
  dts.sort((a, b) => a - b);
  const fs = 1000 / Math.max(1, dts[Math.floor(dts.length / 2)]);
  if (fs < 4) return { error: 'Pulse sampling rate is too low.' };

  // Hann-windowed DFT magnitudes over the physiologic band.
  const n = xs.length;
  const windowed = xs.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const binHz = 0.025;
  const loBin = Math.ceil(0.5 / binHz);
  const hiBin = Math.floor(3.2 / binHz);
  const peakLo = Math.ceil(PULSE_MIN_HZ / binHz);
  const peakHi = Math.floor(PULSE_MAX_HZ / binHz);
  const powers = new Float64Array(hiBin + 1);
  let peakIdx = -1;
  let peakPower = 0;
  let bandPower = 0;
  for (let b = loBin; b <= hiBin; b++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * b * binHz) / fs;
    for (let i = 0; i < n; i++) {
      re += windowed[i] * Math.cos(w * i);
      im -= windowed[i] * Math.sin(w * i);
    }
    const p = re * re + im * im;
    powers[b] = p;
    bandPower += p;
    if (b >= peakLo && b <= peakHi && p > peakPower) {
      peakPower = p;
      peakIdx = b;
    }
  }
  if (peakIdx < 0 || bandPower <= 0) return { error: 'No pulse found in the signal.' };
  const meanBand = bandPower / (hiBin - loBin + 1);
  if (peakPower / meanBand < PULSE_PEAK_RATIO_MIN) return { error: 'No clear heartbeat found in the signal.' };
  let lobePower = 0;
  for (let b = peakIdx - PULSE_LOBE_BINS; b <= peakIdx + PULSE_LOBE_BINS; b++) lobePower += powers[b] || 0;
  const lobeFraction = lobePower / bandPower;
  if (lobeFraction < PULSE_LOBE_FRACTION_MIN) return { error: 'Pulse signal looks like noise.' };
  if (lobeFraction > PULSE_LOBE_FRACTION_MAX) return { error: 'Pulse signal looks synthetic.' };
  return { bpm: Math.round(peakIdx * binHz * 60) };
}

// The submitted pulse and pixel claims must agree with the camera frames'
// actual pixels — recomputed here from the JPEGs, so fabrication has to
// produce real changing pixel data, not just plausible numbers.
const PULSE_FRAME_MIN_MATCH = 4;
const PULSE_FRAME_CORR_MIN = 0.35;
const PULSE_FRAME_SIGN_MIN = 0.66;

function chromaOf({ r, g, b }) {
  const s = r + g + b;
  return s > 0 ? [r / s, g / s, b / s] : [1 / 3, 1 / 3, 1 / 3];
}

function detrended(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, v) => a + v, 0) / n;
  const xm = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xm) * (xs[i] - mean);
    den += (i - xm) * (i - xm);
  }
  const slope = den > 0 ? num / den : 0;
  return xs.map((v, i) => v - mean - slope * (i - xm));
}

// Recompute each frame's face-region green mean, interpolate the submitted
// pulse at those timestamps, and require the two traces to move together.
function validatePulseFrameBinding(pulseSeries, frameSignalsList) {
  if (!Array.isArray(pulseSeries) || !pulseSeries.length) return 'Pulse series is invalid.';
  const usable = frameSignalsList.filter((f) => f.signals);
  if (usable.length < PULSE_FRAME_MIN_MATCH) return 'Camera frames did not cover the pulse window.';
  const byT = pulseSeries.map((s) => s.t);
  // Claims are noisy singletons at ~10Hz while a frame is an instantaneous
  // mean; compare each frame against the local claim average (±140ms) so a
  // single noisy sample can't decorrelate an honest trace.
  const pulseAt = (t) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < byT.length; i += 1) {
      if (byT[i] < t - 140) continue;
      if (byT[i] > t + 140) break;
      sum += pulseSeries[i].g;
      count += 1;
    }
    if (count) return sum / count;
    let lo = 0;
    let hi = byT.length - 1;
    if (t <= byT[0]) return pulseSeries[0].g;
    if (t >= byT[hi]) return pulseSeries[hi].g;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (byT[mid] <= t) lo = mid; else hi = mid;
    }
    const span = byT[hi] - byT[lo] || 1;
    return pulseSeries[lo].g + ((pulseSeries[hi].g - pulseSeries[lo].g) * (t - byT[lo])) / span;
  };
  const span0 = byT[0];
  const span1 = byT[byT.length - 1];
  const inWindow = usable.filter((f) => f.t >= span0 - 200 && f.t <= span1 + 200);
  if (inWindow.length < PULSE_FRAME_MIN_MATCH) return 'Camera frames did not cover the pulse window.';
  const frameG = detrended(inWindow.map((f) => f.signals.g));
  const claimedG = detrended(inWindow.map((f) => pulseAt(f.t)));
  const n = frameG.length;
  const dot = frameG.reduce((a, v, i) => a + v * claimedG[i], 0);
  const magA = Math.sqrt(frameG.reduce((a, v) => a + v * v, 0));
  const magB = Math.sqrt(claimedG.reduce((a, v) => a + v * v, 0));
  const corr = magA > 1e-6 && magB > 1e-6 ? dot / (magA * magB) : 0;
  let signs = 0;
  let signN = 0;
  for (let i = 1; i < n; i += 1) {
    const dF = frameG[i] - frameG[i - 1];
    const dC = claimedG[i] - claimedG[i - 1];
    if (Math.abs(dF) < 1e-4 || Math.abs(dC) < 1e-4) continue;
    signN += 1;
    if (Math.sign(dF) === Math.sign(dC)) signs += 1;
  }
  const signAgree = signN >= 4 ? signs / signN : 0;
  if (corr >= PULSE_FRAME_CORR_MIN || signAgree >= PULSE_FRAME_SIGN_MIN) return null;
  return 'Pulse claim does not match the camera pixels.';
}

// Recompute chroma of each flash-tagged frame and require per-flash deltas to
// track the issued plan — same cosine/ratio rule as validatePixelSeries, but
// measured from the JPEGs rather than client-claimed rows.
function validateFlashFrameBinding(flashFrames, flashPlan) {
  const signalOf = (f) => faceSignals(f.image, f.face);
  const baselineFrames = flashFrames.filter((d) => d.f === -1);
  const baselineChroma = chromaOf(meanSignals(baselineFrames.map(signalOf)));
  for (let i = 0; i < flashPlan.length; i += 1) {
    const during = flashFrames.filter((d) => d.f === i);
    const observed = chromaOf(meanSignals(during.map(signalOf)));
    const expected = chromaOf({ r: flashPlan[i].c[0], g: flashPlan[i].c[1], b: flashPlan[i].c[2] });
    const delta = observed.map((v, k) => v - baselineChroma[k]);
    const expectedDelta = expected.map((v) => v - 1 / 3);
    const deltaMag = Math.hypot(...delta);
    const expectedMag = Math.hypot(...expectedDelta);
    const cosine = deltaMag > 1e-6 && expectedMag > 1e-6
      ? delta.reduce((sum, v, k) => sum + v * expectedDelta[k], 0) / (deltaMag * expectedMag)
      : 0;
    const ratio = deltaMag / expectedMag;
    if (cosine < FLASH_CHROMA_COSINE_MIN || ratio < FLASH_CHROMA_RATIO_MIN || ratio > FLASH_CHROMA_RATIO_MAX) {
      return 'Flash camera pixels did not reflect the issued sequence.';
    }
  }
  return null;
}

function meanSignals(list) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const s of list) {
    if (!s) continue;
    r += s.r;
    g += s.g;
    b += s.b;
    n += 1;
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}

function computeLivenessSeriesDigest(challengeId, motionSeries, pulseSeries) {
  return crypto
    .createHash('sha256')
    .update(`${challengeId}\n${JSON.stringify(motionSeries)}\n${JSON.stringify(pulseSeries || [])}`)
    .digest('hex');
}

function validateMotionSeriesAgainstPlan(motionSeries, plan) {
  if (!Array.isArray(plan) || plan.length < 3) return 'Face liveness plan is invalid.';
  const allowed = new Set(plan);
  for (const sample of motionSeries) {
    if (!sample || typeof sample.p !== 'string' || !allowed.has(sample.p)) {
      return 'Face motion series does not match the issued challenge.';
    }
  }
  return null;
}

// Packed hand landmarks from the client (see HAND_EVIDENCE_LM in app.js).
const H = {
  wrist: 0,
  thumbCmc: 1,
  indexMcp: 2,
  thumbTip: 3,
  indexPip: 4,
  indexTip: 5,
  middlePip: 6,
  middleTip: 7,
  ringPip: 8,
  ringTip: 9,
  pinkyPip: 10,
  pinkyTip: 11,
};
const HAND_EVIDENCE_LM_COUNT = 12;

function packedThumbIpY(hand) {
  const cmcY = hand[H.thumbCmc][1];
  const tipY = hand[H.thumbTip][1];
  return cmcY + (tipY - cmcY) * 0.5;
}

function dist2dLandmark(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function dist3dLandmark(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = (a[2] || 0) - (b[2] || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fingerExtendedPacked(hand, tipIdx, pipIdx) {
  return hand[tipIdx][1] < hand[pipIdx][1] - 0.02;
}

function thumbExtendedPacked(hand) {
  const tip = hand[H.thumbTip];
  const cmc = hand[H.thumbCmc];
  const idxMcpY = hand[H.indexMcp][1];
  const ipY = packedThumbIpY(hand);
  const sideExtent = Math.abs(tip[0] - cmc[0]) > 0.10;
  const tipNotFolded = tip[1] < idxMcpY + 0.02;
  const ipAboveBase = ipY < cmc[1] + 0.05;
  return sideExtent && tipNotFolded && ipAboveBase;
}

function handMatchesThree(hand) {
  if (!Array.isArray(hand) || hand.length < HAND_EVIDENCE_LM_COUNT) return false;
  const index = fingerExtendedPacked(hand, H.indexTip, H.indexPip);
  const middle = fingerExtendedPacked(hand, H.middleTip, H.middlePip);
  const ring = fingerExtendedPacked(hand, H.ringTip, H.ringPip);
  const pinky = fingerExtendedPacked(hand, H.pinkyTip, H.pinkyPip);
  const thumb = thumbExtendedPacked(hand);
  return !thumb && index && middle && ring && !pinky;
}

function handsMatchHeart(hands) {
  if (!Array.isArray(hands) || hands.length < 2) return false;
  for (let i = 0; i < hands.length; i++) {
    for (let j = i + 1; j < hands.length; j++) {
      const left = hands[i];
      const right = hands[j];
      if (!left || !right || left.length < HAND_EVIDENCE_LM_COUNT || right.length < HAND_EVIDENCE_LM_COUNT) continue;
      const thumbTipsTouch = dist3dLandmark(left[H.thumbTip], right[H.thumbTip]) < 0.10;
      const indexTipsTouch = dist3dLandmark(left[H.indexTip], right[H.indexTip]) < 0.10;
      const wristsSeparated = dist3dLandmark(left[H.wrist], right[H.wrist]) > 0.12;
      const leftFingerGap = dist3dLandmark(left[H.thumbTip], left[H.indexTip]) > 0.05;
      const rightFingerGap = dist3dLandmark(right[H.thumbTip], right[H.indexTip]) > 0.05;
      const indexPairY = (left[H.indexTip][1] + right[H.indexTip][1]) / 2;
      const thumbPairY = (left[H.thumbTip][1] + right[H.thumbTip][1]) / 2;
      const indexPairAboveThumbs = indexPairY < thumbPairY + 0.08;
      if (
        thumbTipsTouch
        && indexTipsTouch
        && wristsSeparated
        && leftFingerGap
        && rightFingerGap
        && indexPairAboveThumbs
      ) {
        return true;
      }
    }
  }
  return false;
}

function motionScalar(sample) {
  if (sample && Number.isFinite(sample.v)) return sample.v;
  return 0;
}

function computeMotionFeatures(samples) {
  if (!samples || samples.length < 2) {
    return { holdJitterRms: 0, tortuosity: 1, transitionMs: 0, sampleCount: samples?.length || 0 };
  }
  const values = samples.map(motionScalar);
  const times = samples.map((sample) => Number(sample.t));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const holdJitterRms = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  );
  let pathLength = 0;
  for (let i = 1; i < values.length; i++) {
    pathLength += Math.abs(values[i] - values[i - 1]);
  }
  const chord = Math.abs(values[values.length - 1] - values[0]);
  const tortuosity = pathLength / Math.max(chord, 1e-9);
  return {
    holdJitterRms,
    tortuosity,
    transitionMs: times[times.length - 1] - times[0],
    sampleCount: samples.length,
  };
}

function deriveLivenessPhasesFromMotionSeries(motionSeries, plan) {
  const expected = Array.isArray(plan) && plan.length ? plan : LIVENESS_PLAN_LEFT_FIRST;
  return expected.map((phaseId) => {
    const phaseSamples = motionSeries
      .filter((sample) => sample && sample.p === phaseId)
      .sort((a, b) => Number(a.t) - Number(b.t))
      .map((sample) => ({ t: sample.t, v: sample.v }));
    return { id: phaseId, ...computeMotionFeatures(phaseSamples) };
  });
}

function validateMotionSeriesCoverage(motionSeries, plan) {
  for (const phaseId of plan) {
    const count = motionSeries.filter((sample) => sample?.p === phaseId).length;
    if (count < 3) return 'Face motion series is too sparse for a challenge phase.';
  }
  return null;
}

function validateHandLandmarkGeometry(gestureId, samples) {
  if (!Array.isArray(samples)) return 'Landmark evidence is invalid.';
  if (samples.length > MAX_LANDMARK_SAMPLES) return 'Landmark evidence is too large.';
  if (!samples.length) return null;

  const relevant = samples.filter((sample) => sample && Array.isArray(sample.hands) && sample.hands.length);
  if (!relevant.length) return null;

  if (gestureId === 'three') {
    const ok = relevant.some((sample) => sample.hands[0] && handMatchesThree(sample.hands[0]));
    if (!ok) return 'Hand geometry does not match the requested gesture.';
  }
  if (gestureId === 'ily') {
    const ok = relevant.some((sample) => handsMatchHeart(sample.hands));
    if (!ok) return 'Hand geometry does not match the requested gesture.';
  }
  return null;
}

function isSyntheticLivenessPhase(phase) {
  const jitter = Number(phase?.holdJitterRms);
  const tortuosity = Number(phase?.tortuosity);
  if (!Number.isFinite(jitter) || !Number.isFinite(tortuosity)) return true;
  return jitter <= LIVENESS_SYNTHETIC_JITTER_MAX && tortuosity >= 1 && tortuosity <= LIVENESS_SYNTHETIC_TORTUOSITY_MAX;
}

function validateLivenessPhases(phases, plan, { legacy = false } = {}) {
  const expected = Array.isArray(plan) && plan.length ? plan : LIVENESS_PLAN_LEFT_FIRST;
  if (!Array.isArray(phases) || phases.length !== expected.length) return 'Face liveness phases are incomplete.';
  for (let i = 0; i < expected.length; i++) {
    if (phases[i]?.id !== expected[i]) return 'Face liveness phase order is invalid.';
    const jitter = Number(phases[i].holdJitterRms);
    const tortuosity = Number(phases[i].tortuosity);
    const transitionMs = Number(phases[i].transitionMs);
    const sampleCount = Number(phases[i].sampleCount);
    if (!Number.isFinite(jitter) || !Number.isFinite(tortuosity) || !Number.isFinite(transitionMs) || !Number.isFinite(sampleCount)) {
      return 'Face liveness phase metrics are invalid.';
    }
    if (sampleCount < 3) return 'Face liveness sampling was too sparse.';
  }

  const holdJitterMin = legacy ? LIVENESS_HOLD_JITTER_MIN * 0.5 : LIVENESS_HOLD_JITTER_MIN;
  const transitionJitterMin = legacy ? LIVENESS_TRANSITION_JITTER_MIN * 0.5 : LIVENESS_TRANSITION_JITTER_MIN;
  const tortuosityMin = legacy ? 1.002 : LIVENESS_TORTUOSITY_MIN;

  const transitions = phases.slice(1);

  for (const phase of transitions) {
    if (phase.transitionMs < LIVENESS_TRANSITION_MS_MIN || phase.transitionMs > LIVENESS_TRANSITION_MS_MAX) {
      return 'Head turn timing is outside the allowed range.';
    }
  }

  const hasIrregularity = phases.some(
    (phase) => phase.holdJitterRms >= holdJitterMin || phase.tortuosity >= tortuosityMin
  );
  if (!hasIrregularity) return 'Face motion looked too uniform to count as live presence.';

  const allSynthetic = phases.every((phase) => isSyntheticLivenessPhase(phase));
  if (allSynthetic) return 'Face motion looked synthetic.';

  const transitionOk = (phase) =>
    phase.holdJitterRms >= transitionJitterMin || phase.tortuosity >= tortuosityMin;
  if (transitions.some((phase) => !transitionOk(phase))) {
    return 'Between-pose head motion was too smooth or too abrupt.';
  }

  return null;
}

function issueVerificationToken(session, source, method = 'gesture', assurance = 'standard') {
  persistSession(session);
  const iat = now();
  // The payload is RP-visible: no session id or challenge id — binding stays
  // server-side via issuedTokens/issued_tokens, so a token can't link the
  // live zoe_sid cookie or a stable credential/challenge across relying parties.
  const payload = {
    type: 'zoe.verification',
    action: 'demo.protected-action',
    method,
    assurance,
    nonce: randomId(16),
    iat,
    exp: iat + TOKEN_TTL_MS,
  };
  const token = signPayload(payload);
  const digest = crypto.createHash('sha256').update(token).digest('base64url');
  session.issuedTokens.set(digest, payload);
  persistIssuedToken(digest, session.id, payload);
  return token;
}

function consumeVerificationToken(session, token, allowed) {
  const payload = verifySignedPayload(token);
  if (!payload || payload.type !== 'zoe.verification') return { error: 'Invalid verification token.' };
  if (payload.action !== 'demo.protected-action') return { error: 'Token is not valid for this action.', status: 403 };
  if (now() > payload.exp) return { error: 'Verification token expired.' };

  const methods = allowed?.methods || null;
  const assurances = allowed?.assurances || null;
  if (methods && !methods.includes(payload.method)) return { error: 'Verification method is not allowed for this action.', status: 403 };
  if (assurances && !assurances.includes(payload.assurance)) return { error: 'Verification assurance is not allowed for this action.', status: 403 };

  const digest = crypto.createHash('sha256').update(token).digest('base64url');
  if (usedTokenDigests.has(digest)) return { error: 'Verification token was already used.', status: 409 };
  // Session binding is server-side: the digest must have been issued to this
  // session (in-memory fast path, durable table after a restart).
  const issued = session.issuedTokens.has(digest)
    ? { sessionId: session.id }
    : getIssuedToken(digest);
  if (!issued || issued.sessionId !== session.id) {
    return { error: 'Token is not bound to this session.', status: 403 };
  }

  usedTokenDigests.add(digest);
  persistUsedToken(digest);
  session.issuedTokens.delete(digest);
  deleteIssuedToken(digest);
  return { payload };
}

function decodeCredentialPart(value) {
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function presentedClientChallenge(value) {
  const bytes = decodeCredentialPart(value);
  if (!bytes) return null;
  try {
    const challenge = JSON.parse(bytes.toString('utf8')).challenge;
    return typeof challenge === 'string' && challenge ? challenge : null;
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

function parseSignCount(authenticatorData) {
  if (!Buffer.isBuffer(authenticatorData) || authenticatorData.length < 37) return 0;
  return authenticatorData.readUInt32BE(33);
}

const WEBAUTHN_FLAG_UP = 0x01;
const WEBAUTHN_FLAG_UV = 0x04;

// The browser never sends rp.id in this demo, so the RP ID is the effective
// domain of the validated clientData origin.
function verifyAuthenticatorData(authenticatorData, origin) {
  if (!Buffer.isBuffer(authenticatorData) || authenticatorData.length < 37) {
    return { error: 'Passkey authenticator data was incomplete.' };
  }
  let rpId;
  try {
    rpId = new URL(origin).hostname;
  } catch {
    return { error: 'Passkey origin was invalid.' };
  }
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  if (!authenticatorData.subarray(0, 32).equals(rpIdHash)) {
    return { error: 'Passkey RP ID hash did not verify.' };
  }
  if (!(authenticatorData[32] & WEBAUTHN_FLAG_UP)) {
    return { error: 'Passkey user presence was not verified.' };
  }
  return { userVerified: Boolean(authenticatorData[32] & WEBAUTHN_FLAG_UV) };
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

// ---- WebAuthn attestation ----
// Attestation is the only check that distinguishes a real hardware
// authenticator from a generated software key. Verified packed/apple
// attestation chains → credential can mint 'strong' tokens; everything else
// (fmt 'none', self-attestation, unknown fmt, untrusted chain) → 'standard'.

const FIDO_ROOT_PEMS = [
  `-----BEGIN CERTIFICATE-----
MIICEjCCAZmgAwIBAgIQaB0BbHo84wIlpQGUKEdXcTAKBggqhkjOPQQDAzBLMR8w
HQYDVQQDDBZBcHBsZSBXZWJBdXRobiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJ
bmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTIwMDMxODE4MjEzMloXDTQ1MDMx
NTAwMDAwMFowSzEfMB0GA1UEAwwWQXBwbGUgV2ViQXV0aG4gUm9vdCBDQTETMBEG
A1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTB2MBAGByqGSM49
AgEGBSuBBAAiA2IABCJCQ2pTVhzjl4Wo6IhHtMSAzO2cv+H9DQKev3//fG59G11k
xu9eI0/7o6V5uShBpe1u6l6mS19S1FEh6yGljnZAJ+2GNP1mi/YK2kSXIuTHjxA/
pcoRf7XkOtO4o1qlcaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUJtdk
2cV4wlpn0afeaxLQG2PxxtcwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2cA
MGQCMFrZ+9DsJ1PW9hfNdBywZDsWDbWFp28it1d/5w2RPkRX3Bbn/UbDTNLx7Jr3
jAGGiQIwHFj+dJZYUJR786osByBelJYsVZd2GbHQu209b5RCmGQ21gpSAk9QZW4B
1bWeT0vT
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIEG0BT9zANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZ
dWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAw
MDBaGA8yMDUwMDkwNDAwMDAwMFowLjEsMCoGA1UEAxMjWXViaWNvIFUyRiBSb290
IENBIFNlcmlhbCA0NTcyMDA2MzEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/jwYuhBVlqaiYWEMsrWFisgJ+PtM91eSrpI4TK7U53mwCIawSDHy8vUmk
5N2KAj9abvT9NP5SMS1hQi3usxoYGonXQgfO6ZXyUA9a+KAkqdFnBnlyugSeCOep
8EdZFfsaRFtMjkwz5Gcz2Py4vIYvCdMHPtwaz0bVuzneueIEz6TnQjE63Rdt2zbw
nebwTG5ZybeWSwbzy+BJ34ZHcUhPAY89yJQXuE0IzMZFcEBbPNRbWECRKgjq//qT
9nmDOFVlSRCt2wiqPSzluwn+v+suQEBsUjTGMEd25tKXXTkNW21wIWbxeSyUoTXw
LvGS6xlwQSgNpk2qXYwf8iXg7VWZAgMBAAGjQjBAMB0GA1UdDgQWBBQgIvz0bNGJ
hjgpToksyKpP9xv9oDAPBgNVHRMECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAN
BgkqhkiG9w0BAQsFAAOCAQEAjvjuOMDSa+JXFCLyBKsycXtBVZsJ4Ue3LbaEsPY4
MYN/hIQ5ZM5p7EjfcnMG4CtYkNsfNHc0AhBLdq45rnT87q/6O3vUEtNMafbhU6kt
hX7Y+9XFN9NpmYxr+ekVY5xOxi8h9JDIgoMP4VB1uS0aunL1IGqrNooL9mmFnL2k
LVVee6/VR6C5+KSTCMCWppMuJIZII2v9o4dkoZ8Y7QRjQlLfYzd3qGtKbw7xaF1U
sG/5xUb/Btwb2X2g4InpiB/yt/3CpQXpiWX/K4mBvUKiGn05ZsqeY1gx4g0xLBqc
U9psmyPzK+Vsgw2jeRQ5JlKDyqE0hebfC1tvFu0CCrJFcw==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUSOEjTf//yqRfPW7Qq8qtIyCrAg8wDQYJKoZIhvcNAQEL
BQAwLzEtMCsGA1UEAwwkWXViaWNvIEZJRE8gUm9vdCBDQSBTZXJpYWwgNDUwMjAz
NTU2MCAXDTI0MDUwMTAwMDAwMFoYDzIwNjAwNDMwMDAwMDAwWjAvMS0wKwYDVQQD
DCRZdWJpY28gRklETyBSb290IENBIFNlcmlhbCA0NTAyMDM1NTYwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCdvl27w2gu1fPXeEFbIdqx0BalvVDVWrQP
J7HqviuEtZHlxSLxSFtcXpTolvLvof8f4tMerQTkVGzcmYzm1EBT4IJuMmoEqfkE
EhWpsADMFrjZkqlZY9EqxQzLoVEEonE5oGxSdVCxCcLIackpyR/CCXvj1Bt/hTgE
9hTlF4pRqxMkx3plF7y8dDZlRHWs7vbnhmBCGeI0ZPEQ6nl2mCg2r74adF2u6K9r
rLfhBC3QLE8EPrgqUsI+hkuq2tK4M2SMOp8uUVVkqUeu3h0kr3WVI0W02pkgrOgi
FKLFNkSrbYhdjMBDj5izmqfc9xJRKoDX612qd8ZGVHpT5AYFX+1hAgMBAAGjRTBD
MB0GA1UdDgQWBBTZyU5DiQ/a2UEgE7qBK0zhIsRNRjASBgNVHRMBAf8ECDAGAQH/
AgEAMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEAXvnB4SLuUJfY
MSVGAhssL/SmWli3FSccgxydvKlACcidIIWKQqa3q/QSUEQzC9DgEfMgr7iC1BkT
ZbILboV6UZ5knNsvjEZWuMeogJ8tgZs1hVvKwZizwJ+mEcmsjhIrBYuoL1T6yrOJ
vKFg1jv+Cy4ZwA9Bpk/V3UOir1VyK8dCtyHu6vfosotAdYx8FAuR243gRTMV6Jx8
Jdig2JDIAQMlzVeDpSUHX/K2HXRHxHwfgjbgUjjBu/72r8OfehyhzHXI3K8CFFdf
lO+8nEOJK3y8F1ivgS5uN/8SmcYw/STQYwhrxPuwz3nP8baMum4BB2nnYmpB60sX
3bl5k8QUSw==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIDPjCCAiagAwIBAgIUXzeiEDJEOTt14F5n0o6Zf/bBwiUwDQYJKoZIhvcNAQEN
BQAwJDEiMCAGA1UEAwwZWXViaWNvIEF0dGVzdGF0aW9uIFJvb3QgMTAgFw0yNDEy
MDEwMDAwMDBaGA85OTk5MTIzMTIzNTk1OVowJDEiMCAGA1UEAwwZWXViaWNvIEF0
dGVzdGF0aW9uIFJvb3QgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMZ6/TxM8rIT+EaoPvG81ontMOo/2mQ2RBwJHS0QZcxVaNXvl12LUhBZ5LmiBScI
Zd1Rnx1od585h+/dhK7hEm7JAALkKKts1fO53KGNLZujz5h3wGncr4hyKF0G74b/
U3K9hE5mGND6zqYchCRAHfrYMYRDF4YL0X4D5nGdxvppAy6nkEmtWmMnwO3i0TAu
csrbE485HvGM4r0VpgVdJpvgQjiTJCTIq+D35hwtT8QDIv+nGvpcyi5wcIfCkzyC
imJukhYy6KoqNMKQEdpNiSOvWyDMTMt1bwCvEzpw91u+msUt4rj0efnO9s0ZOwdw
MRDnH4xgUl5ZLwrrPkfC1/0CAwEAAaNmMGQwHQYDVR0OBBYEFNLu71oijTptXCOX
PfKF1SbxJXuSMB8GA1UdIwQYMBaAFNLu71oijTptXCOXPfKF1SbxJXuSMBIGA1Ud
EwEB/wQIMAYBAf8CAQMwDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBDQUAA4IB
AQC3IW/sgB9pZ8apJNjxuGoX+FkILks0wMNrdXL/coUvsrhzsvl6mePMrbGJByJ1
XnquB5sgcRENFxdQFma3mio8Upf1owM1ZreXrJ0mADG2BplqbJnxiyYa+R11reIF
TWeIhMNcZKsDZrFAyPuFjCWSQvJmNWe9mFRYFgNhXJKkXIb5H1XgEDlwiedYRM7V
olBNlld6pRFKlX8ust6OTMOeADl2xNF0m1LThSdeuXvDyC1g9+ILfz3S6OIYgc3i
roRcFD354g7rKfu67qFAw9gC4yi0xBTPrY95rh4/HqaUYCA/L8ldRk6H7Xk35D+W
Vpmq2Sh/xT5HiFuhf4wJb0bK
-----END CERTIFICATE-----`,
];

function fidoRoots() {
  // Re-read per call so tests can inject roots via ZOE_FIDO_ROOT_PEMS (JSON array of PEMs).
  const pems = process.env.ZOE_FIDO_ROOT_PEMS ? JSON.parse(process.env.ZOE_FIDO_ROOT_PEMS) : FIDO_ROOT_PEMS;
  return pems.map((pem) => new crypto.X509Certificate(pem));
}

// Minimal CBOR decoder — sufficient for attestationObject/authData COSE keys.
function cborRead(buf, pos) {
  const ib = buf[pos];
  const major = ib >> 5;
  const ai = ib & 0x1f;
  let p = pos + 1;
  let n = ai;
  if (ai === 24) { n = buf[p]; p += 1; }
  else if (ai === 25) { n = buf.readUInt16BE(p); p += 2; }
  else if (ai === 26) { n = buf.readUInt32BE(p); p += 4; }
  else if (ai === 27) { n = Number(buf.readBigUInt64BE(p)); p += 8; }
  else if (ai === 31 || ai > 27) throw new Error('unsupported CBOR item');
  switch (major) {
    case 0: return [n, p];
    case 1: return [-1 - n, p];
    case 2: return [buf.subarray(p, p + n), p + n];
    case 3: return [buf.subarray(p, p + n).toString('utf8'), p + n];
    case 4: {
      const arr = [];
      for (let i = 0; i < n; i++) { const [v, np] = cborRead(buf, p); arr.push(v); p = np; }
      return [arr, p];
    }
    case 5: {
      const obj = {};
      for (let i = 0; i < n; i++) {
        const [k, kp] = cborRead(buf, p);
        const [v, np] = cborRead(buf, kp);
        obj[k] = v;
        p = np;
      }
      return [obj, p];
    }
    case 7: {
      if (ai === 20) return [false, p];
      if (ai === 21) return [true, p];
      if (ai === 22 || ai === 23) return [null, p];
      if (ai === 26) return [buf.readFloatBE(pos + 1), p];
      if (ai === 27) return [buf.readDoubleBE(pos + 1), p];
      return [n, p];
    }
    default: throw new Error('unsupported CBOR major type');
  }
}

function cborDecode(buf) {
  const [value] = cborRead(buf, 0);
  return value;
}

const SPKI_EC_P256_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

// COSE EC2 P-256 key → SPKI DER (base64url, matching stored credential.publicKey).
function coseKeyToPublic(coseKey) {
  if (coseKey[1] !== 2 || coseKey[-1] !== 1) return null;
  const x = coseKey[-2];
  const y = coseKey[-3];
  if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) return null;
  const der = Buffer.concat([SPKI_EC_P256_PREFIX, Buffer.from([0x04]), x, y]);
  return { publicKey: der.toString('base64url'), alg: typeof coseKey[3] === 'number' ? coseKey[3] : -7 };
}

function certChainsToRoot(x5cDers) {
  try {
    const chain = x5cDers.map((der) => new crypto.X509Certificate(Buffer.isBuffer(der) ? der : Buffer.from(der)));
    const leaf = chain[0];
    const t = new Date();
    if (new Date(leaf.validFrom) > t || new Date(leaf.validTo) < t) return false;
    if (leaf.ca) return false; // attestation leaf must not be a CA
    for (let i = 0; i < chain.length - 1; i++) {
      if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) return false;
    }
    const last = chain[chain.length - 1];
    for (const root of fidoRoots()) {
      if (last.raw.equals(root.raw)) return true;
      if (last.checkIssued(root) && last.verify(root.publicKey)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const APPLE_NONCE_EXTENSION_DER = Buffer.from('06092a864886f763640802', 'hex');

// Apple anonymous attestation carries no signature: trust comes from the
// credCert chaining to a FIDO root, the leaf certifying THIS credential key,
// and the Apple nonce extension (sha256(authData||clientDataHash)) binding the
// cert to this exact attestation. Without all three a harvested real Apple
// chain could be stapled onto an attacker-generated credential key.
function appleAttestationBacked(x5cDers, credential, signedData) {
  if (!x5cDers.length) return false;
  let leaf;
  try {
    leaf = new crypto.X509Certificate(x5cDers[0]);
  } catch {
    return false;
  }
  let leafSpki;
  try {
    leafSpki = leaf.publicKey.export({ format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  if (!leafSpki.equals(Buffer.from(credential.publicKey, 'base64url'))) return false;
  const nonce = crypto.createHash('sha256').update(signedData).digest();
  const raw = leaf.raw;
  const oidIndex = raw.indexOf(APPLE_NONCE_EXTENSION_DER);
  if (oidIndex === -1) return false;
  const nonceMarker = Buffer.concat([Buffer.from([0x04, 0x20]), nonce]);
  return raw.indexOf(nonceMarker, oidIndex) !== -1 && certChainsToRoot(x5cDers);
}

function verifyAttestationSignature(alg, signedData, publicKeySource, signature) {
  const key = typeof publicKeySource === 'string'
    ? crypto.createPublicKey({ key: Buffer.from(publicKeySource, 'base64url'), format: 'der', type: 'spki' })
    : publicKeySource;
  if (alg === -257) {
    return crypto.verify('RSA-SHA256', signedData, key, signature);
  }
  return crypto.verify('SHA256', signedData, key, signature);
}

// Parses a real WebAuthn attestationObject, verifies the RP binding, and
// decides whether the credential is hardware-attested. Returns
// { error } on malformed input, otherwise { hardwareBacked, credentialId, publicKey, alg, fmt }.
function verifyAttestation(attestationObjectB64, clientDataJSONBytes, origin, expectedRawId) {
  const attBytes = decodeCredentialPart(attestationObjectB64);
  if (!attBytes) return { error: 'Passkey attestation object was malformed.' };
  let att;
  try {
    att = cborDecode(attBytes);
  } catch {
    return { error: 'Passkey attestation object was malformed.' };
  }
  const { fmt, attStmt, authData } = att || {};
  if (typeof fmt !== 'string' || !Buffer.isBuffer(authData) || authData.length < 55) {
    return { error: 'Passkey attestation object was malformed.' };
  }

  let rpId;
  try {
    rpId = new URL(origin).hostname;
  } catch {
    return { error: 'Passkey origin was invalid.' };
  }
  if (!authData.subarray(0, 32).equals(crypto.createHash('sha256').update(rpId).digest())) {
    return { error: 'Passkey attestation RP ID hash did not verify.' };
  }
  const flags = authData[32];
  if (!(flags & WEBAUTHN_FLAG_UP)) return { error: 'Passkey user presence was not verified.' };
  if (!(flags & 0x40)) return { error: 'Passkey attestation is missing credential data.' };

  const credIdLen = authData.readUInt16BE(53);
  const credId = authData.subarray(55, 55 + credIdLen);
  const coseBytes = authData.subarray(55 + credIdLen);
  let credential;
  try {
    credential = coseKeyToPublic(cborDecode(coseBytes));
  } catch {
    credential = null;
  }
  if (!credential) return { error: 'Passkey attestation credential key was unsupported.' };
  const credentialId = credId.toString('base64url');
  if (expectedRawId && credentialId !== expectedRawId) {
    return { error: 'Passkey attestation credential ID did not match.' };
  }

  const signedData = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSONBytes).digest()]);
  let hardwareBacked = false;
  if (fmt === 'packed') {
    const x5c = Array.isArray(attStmt && attStmt.x5c) ? attStmt.x5c : [];
    const sig = attStmt && attStmt.sig;
    if (!Buffer.isBuffer(sig)) {
      return { error: 'Passkey attestation signature did not verify.' };
    }
    if (x5c.length) {
      let leaf;
      try {
        leaf = new crypto.X509Certificate(x5c[0]);
      } catch {
        return { error: 'Passkey attestation certificate is malformed.' };
      }
      if (!verifyAttestationSignature(attStmt.alg, signedData, leaf.publicKey, sig)) {
        return { error: 'Passkey attestation signature did not verify.' };
      }
      // Only a chain that reaches an embedded FIDO root proves hardware.
      // Untrusted chains (Chrome/Android software keys emit self-signed ones)
      // still register — they just stay software-backed and cap at 'standard'.
      hardwareBacked = certChainsToRoot(x5c);
    } else {
      // Self attestation: proves key possession, not hardware. Stays 'standard'.
      if (!verifyAttestationSignature(attStmt && attStmt.alg, signedData, credential.publicKey, sig)) {
        return { error: 'Passkey attestation signature did not verify.' };
      }
    }
  } else if (fmt === 'apple') {
    const x5c = Array.isArray(attStmt && attStmt.x5c) ? attStmt.x5c : [];
    const sig = attStmt && attStmt.sig;
    if (!Buffer.isBuffer(sig)) {
      return { error: 'Passkey attestation signature did not verify.' };
    }
    let leaf;
    try {
      leaf = new crypto.X509Certificate(x5c[0]);
    } catch {
      return { error: 'Passkey attestation certificate is malformed.' };
    }
    if (!verifyAttestationSignature(attStmt && attStmt.alg, signedData, leaf.publicKey, sig)) {
      return { error: 'Passkey attestation signature did not verify.' };
    }
    hardwareBacked = appleAttestationBacked(x5c, credential, signedData);
  } else if (fmt !== 'none') {
    return { error: 'Passkey attestation format is not supported.' };
  }

  return {
    fmt,
    hardwareBacked,
    credentialId,
    publicKey: credential.publicKey,
    alg: credential.alg,
  };
}

async function handleApi(req, res, pathname, services = {}) {
  sweepExpiredState();
  // Sessions mint lazily: endpoints that need session state call session(),
  // while non-session endpoints (e.g. /api/verify) never mint a cookie.
  let requestSession = null;
  const session = () => {
    if (!requestSession) requestSession = getSession(req, res);
    return requestSession;
  };
  // Rate limiting uses the already-established session id when the cookie maps
  // to a live session; otherwise it falls back to per-IP limiting — it must
  // never mint a session of its own.
  const rateLimitSessionId = () => {
    const sid = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    const existing = sid ? sessions.get(sid) : null;
    return existing ? existing.id : null;
  };
  if (!enforcePostSecurity(req, res, pathname, rateLimitSessionId())) return;

  if (req.method === 'POST' && pathname === '/api/challenge') {
    const challenge = createChallenge(session());
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
    if (!challenge || challenge.sessionId !== session().id) return sendJson(res, 404, { error: 'Unknown challenge.' });
    if (challenge.consumedAt) return sendJson(res, 409, { error: 'Challenge was already consumed.' });
    if (now() > challenge.expiresAt) return sendJson(res, 410, { error: 'Challenge expired.' });

    if (now() - challenge.stepStartedAt < stepMinElapsedMs()) {
      return sendJson(res, 400, { error: 'Gesture step completed too quickly to be real.' });
    }

    const evidenceError = validateEvidence(challenge, body);
    if (evidenceError) {
      logVerificationFailure('gesture_step_rejected', pathname);
      return sendJson(res, 400, { error: evidenceError });
    }

    challenge.currentStep++;
    if (challenge.currentStep >= challenge.steps.length) {
      challenge.consumedAt = now();
      return sendJson(res, 200, {
        verified: true,
        verificationToken: issueVerificationToken(session(), challenge, 'gesture', 'standard'),
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
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const gate = consumeVerificationToken(session(), body.registrationVerificationToken, {
      methods: ['gesture', 'face-motion'],
      assurances: ['standard'],
    });
    if (gate.error) {
      logVerificationFailure('passkey_register_gate', pathname);
      return sendJson(res, gate.status || 401, { error: gate.error });
    }

    const challenge = randomId(32);
    session().passkeyRegisterChallenges.set(challenge, { createdAt: now(), verifiedBy: gate.payload.method });
    persistSession(session());
    return sendJson(res, 200, {
      challenge,
      rp: { name: APP_NAME },
      user: {
        id: session().id,
        name: `zoe-${session().id.slice(0, 8)}`,
        displayName: 'Zoe user',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60000,
      attestation: 'direct',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: Array.from(session().credentials.keys()).map((id) => ({ type: 'public-key', id })),
    });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/reset') {
    // Demo-only escape hatch for local testing. Registration no longer calls this:
    // users must verify before adding a new Zoe ID passkey, and existing passkeys
    // are preserved instead of being silently cleared.
    session().passkeyRegisterChallenges.clear();
    session().passkeyAuthChallenges.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/register/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const registerChallenge = presentedClientChallenge(body.clientDataJSON);
    const pending = registerChallenge ? session().passkeyRegisterChallenges.get(registerChallenge) : null;
    if (!pending) return sendJson(res, 410, { error: 'Passkey registration expired.' });
    if (now() - pending.createdAt > PASSKEY_CHALLENGE_TTL_MS) {
      session().passkeyRegisterChallenges.delete(registerChallenge);
      return sendJson(res, 410, { error: 'Passkey registration expired.' });
    }
    const client = parseClientData(body.clientDataJSON, 'webauthn.create', registerChallenge);
    if (!client) return sendJson(res, 400, { error: 'Passkey registration challenge did not verify.' });

    const rawId = typeof body.rawId === 'string' ? body.rawId : null;
    let publicKey = typeof body.publicKey === 'string' ? body.publicKey : null;
    let alg = Number(body.alg);
    let hardwareBacked = false;

    if (typeof body.attestationObject === 'string') {
      const att = verifyAttestation(body.attestationObject, client.bytes, client.parsed.origin, rawId);
      if (att.error) return sendJson(res, 400, { error: att.error });
      hardwareBacked = att.hardwareBacked === true;
      publicKey = att.publicKey; // COSE key inside attested credential data is authoritative
      alg = att.alg;
    }
    if (!rawId || !publicKey || ![-7, -257].includes(alg)) {
      return sendJson(res, 400, { error: 'Browser did not provide a usable passkey public key.' });
    }

    session().credentials.set(rawId, {
      id: rawId,
      publicKey,
      alg,
      signCount: 0,
      createdAt: now(),
      hardwareBacked,
    });
    persistSession(session());
    persistCredential(session().id, session().credentials.get(rawId));
    session().passkeyRegisterChallenges.delete(registerChallenge);
    return sendJson(res, 201, { ok: true, credentialId: rawId });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/auth/options') {
    if (!session().credentials.size) return sendJson(res, 409, { error: 'No passkey is registered in this session() yet.' });
    const challenge = randomId(32);
    session().passkeyAuthChallenges.set(challenge, { createdAt: now() });
    persistSession(session());
    return sendJson(res, 200, {
      challenge,
      timeout: 60000,
      userVerification: 'preferred',
      allowCredentials: Array.from(session().credentials.keys()).map((id) => ({ type: 'public-key', id })),
    });
  }

  if (req.method === 'POST' && pathname === '/api/passkey/auth/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const authChallenge = presentedClientChallenge(body.clientDataJSON);
    const pending = authChallenge ? session().passkeyAuthChallenges.get(authChallenge) : null;
    if (!pending) return sendJson(res, 410, { error: 'Passkey challenge expired.' });
    if (now() - pending.createdAt > PASSKEY_CHALLENGE_TTL_MS) {
      session().passkeyAuthChallenges.delete(authChallenge);
      return sendJson(res, 410, { error: 'Passkey challenge expired.' });
    }
    const credential = session().credentials.get(body.rawId);
    if (!credential) return sendJson(res, 404, { error: 'Unknown passkey credential.' });

    const client = parseClientData(body.clientDataJSON, 'webauthn.get', authChallenge);
    const authenticatorData = decodeCredentialPart(body.authenticatorData);
    const signature = decodeCredentialPart(body.signature);
    if (!client || !authenticatorData || !signature) return sendJson(res, 400, { error: 'Passkey response was incomplete.' });
    const authData = verifyAuthenticatorData(authenticatorData, client.parsed.origin);
    if (authData.error) {
      logVerificationFailure('passkey_authenticator_data', pathname);
      return sendJson(res, 401, { error: authData.error });
    }
    if (!verifyPasskeySignature(credential, authenticatorData, client.bytes, signature)) {
      return sendJson(res, 401, { error: 'Passkey signature did not verify.' });
    }

    const signCount = parseSignCount(authenticatorData);
    if (credential.signCount && signCount && signCount <= credential.signCount) {
      return sendJson(res, 401, { error: 'Passkey replay was detected.' });
    }
    credential.signCount = signCount || credential.signCount;
    persistCredential(session().id, credential);
    session().passkeyAuthChallenges.delete(authChallenge);
    // 'strong' requires a real authenticator: verified hardware attestation at
    // registration AND user verification on this assertion. Software keys and
    // fmt:'none' credentials cap at 'standard'.
    const assurance = credential.hardwareBacked && authData.userVerified ? 'strong' : 'standard';
    const token = issueVerificationToken(session(), { id: `passkey:${credential.id}` }, 'passkey', assurance);
    return sendJson(res, 200, { verified: true, verificationToken: token, tokenExpiresAt: now() + TOKEN_TTL_MS });
  }

  if (req.method === 'POST' && pathname === '/api/liveness/challenge') {
    let challengeBody = {};
    try {
      challengeBody = await readJson(req);
    } catch (err) {
      challengeBody = {};
    }
    const created = now();
    const challengeId = randomId();
    const plan = createLivenessPlan();
    const flashPlan = challengeBody.reducedMotion === true ? null : createFlashPlan();
    session().livenessChallenge = {
      id: challengeId,
      plan,
      flashPlan,
      reducedMotion: challengeBody.reducedMotion === true,
      createdAt: created,
      expiresAt: created + LIVENESS_CHALLENGE_TTL_MS,
      consumedAt: null,
      seriesDigests: new Set(),
    };
    persistSession(session());
    return sendJson(res, 201, {
      challengeId,
      plan,
      flashPlan,
      expiresAt: session().livenessChallenge.expiresAt,
    });
  }

  if (req.method === 'POST' && pathname === '/api/liveness/verify') {
    let body;
    try {
      body = await readJson(req, MAX_LIVENESS_BODY_BYTES);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const pending = session().livenessChallenge;
    if (!pending || body.challengeId !== pending.id) {
      return sendJson(res, 400, { error: 'Face liveness challenge is missing or invalid.' });
    }
    if (pending.consumedAt || pending.verifying) return sendJson(res, 409, { error: 'Face liveness challenge was already used.' });
    if (now() > pending.expiresAt) return sendJson(res, 410, { error: 'Face liveness challenge expired.' });

    const minElapsedMs = pending.reducedMotion === true ? Math.max(livenessMinElapsedMs(), reducedMotionMinElapsedMs()) : livenessMinElapsedMs();
    if (now() - pending.createdAt < minElapsedMs) {
      logVerificationFailure('liveness_too_fast', pathname);
      return sendJson(res, 400, { error: 'Face check completed too quickly to be real.' });
    }

    const durationMs = body.durationMs;
    const faceFrames = body.faceFrames;
    const motionScore = body.motionScore;
    const seriesDigest = typeof body.seriesDigest === 'string' ? body.seriesDigest : '';
    const legacy = body.legacyEngine === true;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 900 || durationMs > 15000) {
      return sendJson(res, 400, { error: 'Face check timing is outside the allowed range.' });
    }
    if (typeof faceFrames !== 'number' || !Number.isFinite(faceFrames) || faceFrames < 8) return sendJson(res, 400, { error: 'Face was not visible for long enough.' });
    if (typeof motionScore !== 'number' || !Number.isFinite(motionScore) || motionScore < 0.08) return sendJson(res, 400, { error: 'Face motion was too small to count as liveness.' });
    if (!/^[a-f0-9]{64}$/.test(seriesDigest)) return sendJson(res, 400, { error: 'Face motion digest is invalid.' });

    const motionSeries = body.motionSeries;
    if (!Array.isArray(motionSeries) || motionSeries.length < 3 || motionSeries.length > MAX_MOTION_SERIES) {
      return sendJson(res, 400, { error: 'Face motion series is invalid.' });
    }
    const seriesPlanError = validateMotionSeriesAgainstPlan(motionSeries, pending.plan);
    if (seriesPlanError) return sendJson(res, 400, { error: seriesPlanError });
    const coverageError = validateMotionSeriesCoverage(motionSeries, pending.plan);
    if (coverageError) return sendJson(res, 400, { error: coverageError });
    const pulseSeriesBody = body.pulseSeries;
    const expectedDigest = computeLivenessSeriesDigest(pending.id, motionSeries, pulseSeriesBody);
    if (expectedDigest !== seriesDigest) {
      return sendJson(res, 400, { error: 'Face evidence digest does not match the submitted series.' });
    }

    const derivedPhases = deriveLivenessPhasesFromMotionSeries(motionSeries, pending.plan);
    const phaseError = validateLivenessPhases(derivedPhases, pending.plan, { legacy });
    if (phaseError) {
      logVerificationFailure('liveness_phases_rejected', pathname);
      return sendJson(res, 400, { error: phaseError });
    }

    const mediaValidation = validatePresentationFrames(pending.id, body.mediaFrames, body.mediaDigest);
    if (mediaValidation.error) {
      logVerificationFailure('liveness_media_rejected', pathname);
      return sendJson(res, 400, { error: mediaValidation.error });
    }
    if (pending.presentationDigest && pending.presentationDigest !== body.mediaDigest) {
      return sendJson(res, 400, { error: 'Camera media changed during this verification attempt.' });
    }
    let presentationResult;
    if (pending.presentationDigest) {
      presentationResult = pending.presentationResult;
    } else {
      pending.mediaAttempts = (pending.mediaAttempts || 0) + 1;
      if (pending.mediaAttempts > 3) {
        pending.consumedAt = now();
        session().livenessChallenge = null;
        return sendJson(res, 429, { error: 'Too many camera media attempts on this challenge.' });
      }
      try {
        const analyzer = services.analyzePresentationFrames || analyzePresentationFrames;
        pending.verifying = true;
        presentationResult = await analyzer(mediaValidation.frames);
      } catch (err) {
        console.error('Face presentation analysis failed:', err.message);
        return sendJson(res, 503, { error: 'Face presentation analysis is temporarily unavailable.' });
      } finally {
        pending.verifying = false;
      }
    }
    if (!presentationResult || presentationResult.real !== true) {
      logVerificationFailure('liveness_presentation_rejected', pathname);
      return sendJson(res, 400, { error: 'The camera view looked like a photo or screen. Try again with your face clearly visible.' });
    }
    pending.presentationDigest = body.mediaDigest;
    pending.presentationResult = presentationResult;

    // The claimed pulse must agree with the frames' own pixels — recomputed
    // green means over the face region, interpolated against the submitted
    // series. Fabricated series can't match real (or static) camera data.
    const pulseFrameSignals = mediaValidation.frames.map((f) => ({ t: f.t, signals: faceSignals(f.image, f.face) }));
    const pulseBindingError = validatePulseFrameBinding(body.pulseSeries, pulseFrameSignals);
    const pulseResult = pulseBindingError
      ? { error: pulseBindingError }
      : validatePulseSeries(body.pulseSeries, pending.reducedMotion);
    if (pulseResult.error) {
      logVerificationFailure('liveness_pulse_rejected', pathname);
      if (!pending.flashPlan) {
        return sendJson(res, 400, { error: pulseResult.error });
      }
      if (body.flashFallback !== true) {
        pending.flashOfferedAt = now();
        return sendJson(res, 422, {
          error: 'We could not confirm your presence from the pulse scan.',
          flashAvailable: true,
        });
      }
      if (!pending.flashOfferedAt) {
        return sendJson(res, 400, { error: 'Flash fallback was not offered for this attempt.' });
      }
      const pixelError = validatePixelSeries(body.pixelSeries, pending.flashPlan);
      if (pixelError) {
        logVerificationFailure('liveness_pixels_rejected', pathname);
        return sendJson(res, 400, { error: pixelError });
      }
      const flashFramesValidation = validateFlashFrames(pending.id, body.flashFrames, body.flashDigest, pending.flashPlan);
      if (flashFramesValidation.error) {
        logVerificationFailure('liveness_flash_frames_rejected', pathname);
        return sendJson(res, 400, { error: flashFramesValidation.error });
      }
      const flashBindingError = validateFlashFrameBinding(flashFramesValidation.frames, pending.flashPlan);
      if (flashBindingError) {
        logVerificationFailure('liveness_flash_frames_rejected', pathname);
        return sendJson(res, 400, { error: flashBindingError });
      }
    }

    if (pending.seriesDigests.has(seriesDigest)) {
      return sendJson(res, 400, { error: 'Replay face motion evidence was already submitted.' });
    }
    pending.seriesDigests.add(seriesDigest);
    pending.consumedAt = now();
    session().livenessChallenge = null;

    const token = issueVerificationToken(session(), { id: `face:${pending.id}` }, 'face-motion', 'standard');
    return sendJson(res, 200, {
      verified: true,
      verificationToken: token,
      tokenExpiresAt: now() + TOKEN_TTL_MS,
      pulseBpm: pulseResult.bpm || null,
      usedFlashFallback: Boolean(pulseResult.error),
    });
  }

  if (req.method === 'POST' && pathname === '/api/verify') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const payload = verifySignedPayload(body.verificationToken);
    if (!payload || payload.type !== 'zoe.verification') return sendJson(res, 401, { error: 'Invalid verification token.' });
    if (now() > payload.exp) return sendJson(res, 401, { error: 'Verification token expired.' });

    const digest = crypto.createHash('sha256').update(body.verificationToken).digest('base64url');
    if (usedTokenDigests.has(digest)) return sendJson(res, 409, { error: 'Verification token was already used.' });

    usedTokenDigests.add(digest);
    persistUsedToken(digest);
    // The payload no longer carries the session id: resolve the issuer through
    // the persisted issued-token digest so the pending entry is released too.
    const issued = getIssuedToken(digest);
    if (issued) {
      const issuingSession = sessions.get(issued.sessionId);
      if (issuingSession) issuingSession.issuedTokens.delete(digest);
      deleteIssuedToken(digest);
    }

    return sendJson(res, 200, {
      valid: true,
      action: payload.action,
      method: payload.method,
      assurance: payload.assurance,
      expiresAt: payload.exp,
    });
  }

  if (req.method === 'POST' && pathname === '/api/protected-action') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const gate = consumeVerificationToken(session(), body.verificationToken);
    if (gate.error) {
      logVerificationFailure('protected_action_gate', pathname);
      return sendJson(res, gate.status || 401, { error: gate.error });
    }
    return sendJson(res, 200, { ok: true, message: 'Protected action accepted by the server.' });
  }

  return sendJson(res, 404, { error: 'Unknown API route.' });
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.tflite' || ext === '.task') return 'application/octet-stream';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

const STATIC_FILES = new Set([
  '/index.html', '/styles.css', '/app.js', '/face_calib.js',
  '/models/blaze_face_short_range.tflite',
]);
const DEBUG_FILES = new Set(['/debug.html', '/debug.css', '/debug.js', '/debug_metrics.js']);
const VENDOR_FILES = new Set([
  '/vendor/mediapipe/hands/hands.js',
  '/vendor/mediapipe/hands/hands.binarypb',
  '/vendor/mediapipe/hands/hands_solution_packed_assets_loader.js',
  '/vendor/mediapipe/hands/hands_solution_packed_assets.data',
  '/vendor/mediapipe/hands/hands_solution_simd_wasm_bin.js',
  '/vendor/mediapipe/hands/hands_solution_simd_wasm_bin.wasm',
  '/vendor/mediapipe/hands/hands_solution_wasm_bin.js',
  '/vendor/mediapipe/hands/hands_solution_wasm_bin.wasm',
  '/vendor/mediapipe/hands/hand_landmark_full.tflite',
  '/vendor/mediapipe/hands/hand_landmark_lite.tflite',
  '/vendor/mediapipe/camera_utils/camera_utils.js',
  '/vendor/mediapipe/drawing_utils/drawing_utils.js',
  '/vendor/mediapipe/tasks-vision/vision_bundle.mjs',
  '/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
  '/vendor/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
  '/vendor/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js',
  '/vendor/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm',
]);

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const debugAllowed = DEBUG_FILES.has(requested) && process.env.ZOE_DEBUG === '1';
  if (!STATIC_FILES.has(requested) && !VENDOR_FILES.has(requested) && !debugAllowed) {
    securityHeaders(res);
    res.writeHead(404);
    return res.end('Not found');
  }
  const filePath = path.resolve(__dirname, `.${requested}`);
  const rel = path.relative(__dirname, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
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

function createServer(services = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url.pathname, services).catch((err) => {
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
    if (process.env.ZOE_DEBUG === '1') {
      console.log(`Camera lab: http://${HOST}:${PORT}/debug.html`);
    }
  });
}

module.exports = {
  createServer,
  sessions,
  checkRateLimit,
  resetRateLimitState,
  validateStateChangingOrigin,
  sweepExpiredState,
  STATE_CHANGING_POST_PATHS,
  RATE_LIMIT_MAX_PER_IP,
  createLivenessPlan,
  computeLivenessSeriesDigest,
  deriveLivenessPhasesFromMotionSeries,
  validateHandLandmarkGeometry,
  verifyAuthenticatorData,
  createFlashPlan,
  validatePixelSeries,
  computePresentationDigest,
  validatePresentationFrames,
  computeFlashDigest,
  validateFlashFrames,
};
