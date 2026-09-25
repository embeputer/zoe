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

Then open `http://localhost:3001` (or match your `PORT`). Use `localhost`, not `127.0.0.1` — IP literals aren't valid WebAuthn relying-party IDs, so Zoe ID throws `SecurityError` on an IP host (APIs/curl work fine on 127.0.0.1).

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
| `ZOE_RATE_LIMIT_MAX_PER_SESSION` | `60` | Max POST API requests per session per window (`0` disables session limit) |
| `ZOE_SESSION_IDLE_TTL_MS` | `3600000` | Drop idle sessions after this many ms |
| `ZOE_SWEEP_INTERVAL_MS` | `30000` | Minimum interval between in-memory expiry sweeps |
| `ZOE_LOG_VERIFICATION_FAILURES` | off | Set to `1` to emit JSON lines for verification rejections (reason code only, no PII) |
| `ZOE_DB_PATH` | `./zoe-data.sqlite3` | SQLite file for durable sessions, passkey credentials, and consumed token digests (`:memory:` disables persistence) |
| `ZOE_FIDO_ROOT_PEMS` | embedded Apple + Yubico roots | JSON array of PEMs replacing the built-in attestation trust anchors (tests inject a generated root) |
| `ZOE_FACE_PAD_MODEL` | `models/face_antispoof_quantized.onnx` | Server-side face presentation-attack model |
| `ZOE_FACE_DETECTOR_MODEL` | `models/face_detector.onnx` | Server-side face detector used to validate submitted face regions |

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

## Camera Debug Lab

```sh
npm run debug
```

Open `http://localhost:3001/debug.html`. The disposable camera lab reports face confidence, pulse detection, estimated BPM, signal quality, flash baseline coverage, and per-color response direction/strength. It does not call verification APIs or issue tokens, and its files return 404 unless the server starts with `ZOE_DEBUG=1`.

## Bundled Models

The server-side MiniFASNetV2-SE presentation model and YuNet-style face detector come from [`facenox/face-antispoof-onnx`](https://github.com/facenox/face-antispoof-onnx). Their MIT license is retained in `models/face_antispoof_LICENSE.txt`.

## Adversarial Harness

```sh
npm run attack
```

`attack_server.js` spins up the real server and submits fully fabricated evidence — no camera or MediaPipe — including a procedural face, synthesized pulse, and pixels that match the issued flash sequence. Server-side face detection plus presentation analysis blocks the harness's fabricated and replayed-summary face attacks. The hand-gesture route remains forgeable because it still accepts client-generated landmark evidence, and face PAD does not prove camera provenance or defeat a sufficiently realistic injected/replayed feed.

```sh
npm run attack:agent
```

`attack_agent.js` probes the API-level surface an autonomous agent sees — no media fabrication needed, just protocol abuse. Measured results:

- **BLOCKED — instant verification.** The server now compares `now() - challenge.createdAt` to a wall-clock floor (`ZOE_LIVENESS_MIN_ELAPSED_MS`, default 14s — the pulse stage's real duration; `ZOE_STEP_MIN_ELAPSED_MS`, default 180ms per gesture step). A "20-second" verification submitted in ~40ms is rejected, which also caps attempt rate at ~1 per real flow duration.
- **BLOCKED — scripted Zoe ID caps at `'standard'`.** Registration now asks the authenticator for an attestation (`attestation: 'direct'`) and verifies it: a `packed`/`apple` x5c chain reaching an embedded FIDO root (Apple, Yubico) marks the credential `hardwareBacked`; `fmt 'none'`, self-attestation, and chains that don't reach a known root (Chrome/Android software keys emit self-signed leaves) still register but stay software. A generated P-256 keypair completes the whole Zoe ID lifecycle but redeems `assurance: 'standard'` — `'strong'` requires hardware attestation plus a user-verified (UV) assertion.
- **BLOCKED — type coercion.** Payload field types are asserted (`typeof === 'number'`), not coerced — `"2400"` as a string is now a 400.
- **INFO — session farming closed.** Anonymous requests mint memory-only sessions; a row is persisted only when the session gains real state (challenge, credential, token).
- **BLOCKED — token double-redeem** across `/api/protected-action` + `/api/verify` (one wins, one 409s).
- **BLOCKED — challenge binding.** Liveness challenges live in a per-session slot with unguessable ids; cross-session use and id guessing both 400.
- **BLOCKED — rate limit.** First 429 lands at the 120/min IP cap; the per-session limiter is also on by default (60/min, `ZOE_RATE_LIMIT_MAX_PER_SESSION`), so cookie rotation gains nothing — distributed IPs still bypass it.

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
4. During the calm front-facing tail, the browser captures three to five bounded 320×240 JPEG frames with normalized face regions and a digest bound to the challenge id.
5. The server validates frame count, spacing, duration, dimensions, encoded size, uniqueness, and digest binding. It independently detects a face in consecutive frames, compares the detected regions with the submitted regions, then runs the bundled MiniFASNet presentation-attack model over the face crops.
6. Face verification also uses rPPG as its default media gate: the client samples green-channel means over a forehead ROI during centering and head turns, then adds a short stillness top-up. The server analyzes the stillness tail for a physiologic-band heartbeat (48–144 BPM, rejecting flat and clean-sine signals).
7. If pulse is inconclusive, Zoe keeps the challenge open and explicitly offers a flash-reflection fallback. Flash never auto-starts. The accepted frame digest and presentation result stay fixed across that retry, so flash cannot replace rejected media.
8. The server validates order, wall-clock timing, replay state, presentation analysis, pulse or explicitly accepted flash evidence, and session binding.
9. After all steps pass, the server issues a short-lived signed token that the protected action accepts once.

Relying parties can redeem a token without the user's session cookie via `POST /api/verify` with `{ "verificationToken": "..." }`. It validates the signature and expiry, enforces one-use, and returns `{ valid, action, method, assurance, expiresAt }`. A second redemption returns `409`. Production deployments should additionally authenticate the calling party (e.g. a shared RP secret).

## Accessibility And Bad Camera Conditions

The UI gives camera guidance when detection struggles. Users can choose a different primary method before verification:

- **Zoe ID**: strongest repeat-use path. Approved users verify with a passkey through WebAuthn, and the server verifies the signed assertion. At registration the server also verifies the authenticator's attestation: credentials whose packed/apple x5c chain reaches an embedded FIDO root are marked hardware-backed, and only those (with a user-verified assertion) mint `assurance: 'strong'` tokens — everything else caps at `'standard'`.
- **Face motion**: primary local face-motion check using MediaPipe Tasks Vision FaceDetector (cross-browser; works in Chrome, Safari, and Firefox under a strict CSP). The compatible short-range detector model is served locally from `models/`, and the browser verifies confidence, face-sized bounds, target-oval position, and eye/nose keypoint yaw before counting server-prompted head turns (`center_hold`, then left-first or right-first). The server issues the phase plan, validates phase order/metrics, and checks a `challengeId`-bound `seriesDigest` over the submitted `motionSeries`. Standard motion checks also include loose micro-jitter and path-tortuosity heuristics on hold and between-pose samples (not virtual-camera protection). It falls back to the browser `FaceDetector` API only when the MediaPipe runtime cannot load, using box motion because that fallback has no keypoints. It checks liveness-style motion, not identity.

There is no emergency text/audio verification path. When camera detection takes a bit, Zoe shows passive camera guidance while the user keeps trying the selected method.

## Security Notes

Face checks now include bounded challenge-bound frames, independent server face-region validation, and temporal presentation analysis. This raises the cost above simply speaking Zoe's public JSON protocol, but it does not prove that frames came from a physical camera and should not be marketed as immune to injected media, high-quality replay, or advanced generated video. Production use still needs evaluated PAD thresholds and datasets, camera/device integrity signals where available, abuse monitoring, datastore-backed rate limits, deployment-specific origin policy, secret management, retention/privacy policy, and a complete accessibility policy.
