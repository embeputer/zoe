# Zoe

Zoe is a small human-presence verification demo. The browser can run hand gesture checks or face-motion liveness locally, while the server owns challenge state, replay protection, and one-use verification tokens.

## Requirements

- Node.js 22.5 or newer (uses `node:sqlite` for durable state)
- A browser with camera support
- Network access to `cdn.jsdelivr.net` for MediaPipe assets

## Run Locally

```sh
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

Do not open `index.html` directly with `file://`. Verification is intentionally server-bound, so the app needs the local server.

If port `3000` is already in use:

```sh
env PORT=3001 npm start
```

Then open `http://127.0.0.1:3001` (or match your `PORT`).

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `NODE_ENV` | (unset) | Set to `production` to enforce production hardening |
| `ZOE_SECRET` | ephemeral in dev | HMAC signing secret for verification tokens |
| `ZOE_REQUIRE_SECRET` | off | Set to `1` to require `ZOE_SECRET` even when not in production |
| `ZOE_ALLOWED_ORIGINS` | `http://127.0.0.1:3000`, `http://127.0.0.1:3001`, `http://localhost:3000`, `http://localhost:3001` | Comma-separated browser origins allowed on state-changing POST APIs |
| `ZOE_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) per IP / session bucket |
| `ZOE_RATE_LIMIT_MAX_PER_IP` | `120` | Max POST API requests per IP per window |
| `ZOE_RATE_LIMIT_MAX_PER_SESSION` | `0` | Max POST API requests per session per window (`0` disables session limit) |
| `ZOE_SESSION_IDLE_TTL_MS` | `3600000` | Drop idle sessions after this many ms |
| `ZOE_SWEEP_INTERVAL_MS` | `30000` | Minimum interval between in-memory expiry sweeps |
| `ZOE_LOG_VERIFICATION_FAILURES` | off | Set to `1` to emit JSON lines for verification rejections (reason code only, no PII) |
| `ZOE_DB_PATH` | `./zoe-data.sqlite3` | SQLite file for durable sessions, passkey credentials, and consumed token digests (`:memory:` disables persistence) |

### Production behavior

When `NODE_ENV=production` or `ZOE_REQUIRE_SECRET=1`:

- The server **exits on startup** if `ZOE_SECRET` is not set.
- State-changing POST requests **must** include an allowed `Origin` or `Referer` (browser clients normally send `Origin`).

In development, missing `Origin`/`Referer` is allowed (for curl and tests). HTTP origins on `localhost` or `127.0.0.1` with any port are also accepted; production requires an exact match in `ZOE_ALLOWED_ORIGINS`. An ephemeral `ZOE_SECRET` is generated once per process with a single console warning.

Rate limits apply in-memory to POST routes under `/api/challenge`, `/api/step`, `/api/liveness/*`, passkey routes, and `/api/protected-action`. Over-limit clients receive HTTP `429` with a clear error message.

## Test

```sh
npm test
```

## Adversarial Harness

```sh
npm run attack
```

`attack_server.js` spins up the real server and submits fully fabricated evidence — no camera, no MediaPipe — including synthesized pixel streams that match the issued flash sequence and pulse series with a physiologic-band spectral peak. It reports which checks a scripted client fools and documents the honest ceiling of client-side evidence: even pulse-checked, pixel-verified flash liveness stays forgeable by a script that synthesizes matching signals. Closing that hole needs server-side media verification (e.g. a PAD model on uploaded frames) or hardware attestation.

```sh
npm run attack:agent
```

`attack_agent.js` probes the API-level surface an autonomous agent sees — no media fabrication needed, just protocol abuse. Measured results:

- **BLOCKED — instant verification.** The server now compares `now() - challenge.createdAt` to a wall-clock floor (`ZOE_LIVENESS_MIN_ELAPSED_MS`, default 14s — the pulse stage's real duration; `ZOE_STEP_MIN_ELAPSED_MS`, default 180ms per gesture step). A "20-second" verification submitted in ~40ms is rejected, which also caps attempt rate at ~1 per real flow duration.
- **FOOLED — Zoe ID is still scriptable, just slower.** `attestation: 'none'` + register accepting any SPKI key means a generated P-256 keypair registers behind a forged liveness token and mints `'strong'` assurance with self-asserted UP|UV flags — the floor only makes each attempt cost ≥14s. Closing it needs real attestation (packed/fido-u2f + AAGUID allowlist), not more statistics.
- **BLOCKED — type coercion.** Payload field types are asserted (`typeof === 'number'`), not coerced — `"2400"` as a string is now a 400.
- **INFO — session farming closed.** Anonymous requests mint memory-only sessions; a row is persisted only when the session gains real state (challenge, credential, token).
- **BLOCKED — token double-redeem** across `/api/protected-action` + `/api/verify` (one wins, one 409s).
- **BLOCKED — challenge binding.** Liveness challenges live in a per-session slot with unguessable ids; cross-session use and id guessing both 400.
- **BLOCKED — rate limit.** First 429 lands at the 120/min IP cap; cookie rotation gains nothing, but distributed IPs bypass it and the per-session limiter ships disabled (`ZOE_RATE_LIMIT_MAX_PER_SESSION=0`).

The regression test starts a temporary local HTTP server and checks that:

- fake client-side verification is rejected
- assisted/fallback verification endpoints are not available
- empty Zoe ID sessions cannot authenticate a passkey
- out-of-order challenge steps are rejected
- valid challenge completion issues a token
- verification tokens are single-use

## How It Works

1. The browser asks the server for a challenge.
2. The user chooses a primary verification method, such as hand gestures or face motion.
3. The browser performs the local check and submits bounded evidence for that step.
4. Face verification ends with two server-side liveness checks: an rPPG pulse stage (the client samples green-channel means over a forehead ROI for ~14s; the server runs spectral analysis for a physiologic-band heartbeat, 48–144 BPM, rejecting flat and clean-sine signals) followed by a flash challenge (the server issues a random color sequence, the screen flashes it, and the client uploads timestamped face-region pixel bursts the server checks for correlation, coverage, and sensor noise). The flash plan is slowed to ~1 flash/second for photosensitivity, and `prefers-reduced-motion` clients skip it entirely — the pulse check alone then carries the liveness gate.
5. The server validates order, timing, replay state, pulse + pixel evidence, and session binding.
6. After all steps pass, the server issues a short-lived signed token.
7. The protected action accepts only that server-issued token, once.

Relying parties can redeem a token without the user's session cookie via `POST /api/verify` with `{ "verificationToken": "..." }`. It validates the signature and expiry, enforces one-use, and returns `{ valid, action, method, assurance, expiresAt }`. A second redemption returns `409`. Production deployments should additionally authenticate the calling party (e.g. a shared RP secret).

## Accessibility And Bad Camera Conditions

The UI gives camera guidance when detection struggles. Users can choose a different primary method before verification:

- **Zoe ID**: strongest repeat-use path. Approved users verify with a passkey through WebAuthn, and the server verifies the signed assertion.
- **Face motion**: primary local face-motion check using MediaPipe Tasks Vision FaceDetector (cross-browser; works in Chrome, Safari, and Firefox under a strict CSP). The compatible short-range detector model is served locally from `models/`, and the browser verifies confidence, face-sized bounds, target-oval position, and eye/nose keypoint yaw before counting server-prompted head turns (`center_hold`, then left-first or right-first). The server issues the phase plan, validates phase order/metrics, and checks a `challengeId`-bound `seriesDigest` over the submitted `motionSeries`. Standard motion checks also include loose micro-jitter and path-tortuosity heuristics on hold and between-pose samples (not virtual-camera protection). It falls back to the browser `FaceDetector` API only when the MediaPipe runtime cannot load, using box motion because that fallback has no keypoints. It checks liveness-style motion, not identity.

There is no emergency text/audio verification path. When camera detection takes a bit, Zoe shows passive camera guidance while the user keeps trying the selected method.

## Security Notes

This patch fixes the original client-side trust-boundary problem and adds a pixel-verified flash challenge to face checks, but it is still a demo — the attack harness proves a script synthesizing matching pixels still fools it. For high-value production use, add server-side media verification, abuse monitoring, durable storage, passkey credentials stored on user accounts instead of in memory, rate limits backed by a shared datastore (this demo uses in-memory limits only), secret management via your platform, CSRF/origin allowlists tuned to your deployment (`ZOE_ALLOWED_ORIGINS`), and a fully designed accessibility policy.
