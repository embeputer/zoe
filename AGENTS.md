# Agent Notes

## Project

Zoe is a server-bound human verification demo. The browser runs local camera checks for face motion or hand gestures, but the server owns challenge state, replay protection, passkey verification, and one-use verification tokens.

This is a plain Node/static app:

- `server.js` serves files and implements all API routes.
- `app.js` owns browser UI state, MediaPipe hand detection, face-motion checks, passkey calls, and camera-help UI.
- `index.html` is the single page.
- `styles.css` is the complete UI styling.
- `test_server.js` is the regression/security test suite.
- `attack_server.js` is the adversarial harness: it submits fully fabricated evidence and reports which server checks a scripted client fools.
- `face_pad.js` validates bounded challenge-bound JPEG frames, independently detects face regions, and runs server-side presentation-attack analysis.
- `debug.html`, `debug.js`, and `debug_metrics.js` form a disposable pulse/flash camera lab available only through `npm run debug`.

Sessions, passkey credentials, and consumed token digests persist in SQLite (`node:sqlite`, file `zoe-data.sqlite3`, override with `ZOE_DB_PATH`; tests use `:memory:` or a temp file). Session rows persist lazily — a cookie-only anonymous hit stays memory-only until the session gains real state (challenge, credential, token). Short-lived challenge state stays in memory. Verification enforces wall-clock floors server-side (`ZOE_LIVENESS_MIN_ELAPSED_MS`, `ZOE_STEP_MIN_ELAPSED_MS`; tests shorten them via env). Relying parties redeem tokens via `POST /api/verify` (signature + expiry + one-use; no session cookie required).

## Run And Test

Use:

```sh
npm start
npm test
npm run debug
```

The app must be served over the local server. Do not open `index.html` with `file://`.

Default server URL:

```text
http://127.0.0.1:3000
```

In this workspace, port `3000` is often busy, so previous work has used:

```sh
env PORT=3001 npm start
```

The test suite binds a temporary local HTTP server. In sandboxed Codex sessions, `npm test` may need elevated permission because binding `127.0.0.1` can fail with `EPERM`.

## Current Product Flow

The intended UX is:

1. Info card first.
2. Desktop: user presses `Verify now`, then sees a method-choice page with:
   - Face motion
   - Hand gestures
   - Zoe ID
3. Zoe ID opens an intermediate page asking whether the user already has Zoe ID, with actions to use an existing passkey or register Zoe ID.
4. Mobile: user presses `Verify now`, then Zoe defaults directly to face verification.
5. Mobile verification also shows a `Use Zoe ID` button, which opens the Zoe ID intermediate page.
6. Once a user has chosen face or hands, the verification page should not show another face/hand switcher.
7. Choosing face or hands auto-starts that check (camera + flow begin immediately via `autoStartVerification`/`beginVerification` in `app.js`); the `Start check` button remains as a manual retry after an error. Returning from the Zoe ID page does not auto-start.

Do not reintroduce a fake phone frame. The design is inspired by the card inside a Persona Relay-style flow, not by rendering a whole phone mockup.

## Verification Methods

### Face Motion

Face motion is the default on mobile. It runs cross-browser using MediaPipe Tasks Vision (`@mediapipe/tasks-vision`), imported dynamically in `app.js`. The WASM runtime loads from `cdn.jsdelivr.net`, and the active compatible short-range FaceDetector model is vendored locally at `models/blaze_face_short_range.tflite` and served from the same origin. The Tasks Vision FaceDetector is the active gate because it exposes confidence scores, a conventional bounding box, and face keypoints; the browser validates confidence, size/aspect, target-oval position, and eye/nose keypoint yaw before counting prompted head turns. The older `@mediapipe/face_detection` Solutions build is intentionally avoided because it evaluates strings as JavaScript and would require loosening the CSP. The browser's non-standard `FaceDetector` API is used only as an opportunistic fallback when the MediaPipe runtime cannot load; it has no keypoints, so only that fallback uses box-motion gates. It is a liveness-style motion check, not identity verification.

The face check is a guided flow (`runGuidedFaceCheck` in `app.js`): it draws a target oval, follows the server-issued left-first or right-first motion plan, collects forehead green-channel samples throughout, then uses a calm front-facing tail to top up pulse evidence and capture up to five 320×240 JPEG frames. The frames include bounded timestamps and normalized client face regions; `mediaDigest` binds their exact JSON representation to `challengeId`. `face_pad.js` enforces count, spacing, span, size, dimensions, uniqueness, and digest bounds, then runs the vendored YuNet-style detector independently on each frame before running MiniFASNetV2-SE presentation analysis on the matched face crop. Acceptance requires three consecutive independently detected faces, three consecutive real PAD results, and a passing median PAD score. An accepted digest/result is cached on the challenge so explicit flash fallback cannot replace the media set. Pulse remains the default media gate; failed pulse may offer flash only after affirmative photosensitivity consent, and flash never auto-starts. These checks raise attack cost but do not prove camera provenance or defeat realistic injected/replayed video.

Known face-detector findings:

- `models/blaze_face_short_range.tflite` is the compatible active model. Prior browser debugging showed it can detect the user's face around ~86-87% confidence.
- `models/blaze_face_full_range.tflite` was tested and is incompatible with the Tasks FaceDetector graph in this app (`raw_box_tensor ... 2304 vs 896`). Do not reintroduce it unless the graph/model compatibility is proven first.
- `models/face_landmarker.task` was removed from the active path because the landmarker-only approach could hallucinate a mesh on shoulder/neck/background skin without a usable per-face confidence score.
- Keep the face logic boring: detector output → one centralized box calibration (`calibratedFaceBox`) → size/oval gates → eye/nose keypoint yaw → explicit center/left/right state machine. Detector and evidence coordinates stay unmirrored (`displayedFaceX(box) === box.cx`); only the camera pixels drawn by `drawFaceGuide` are mirrored for selfie-style guidance. Do not stack ad hoc keypoint-derived boxes, scattered `1 - box.cx` conversions, or extra draw-only offsets.
- `calibratedFaceBox` currently shifts the raw Blaze box left by `0.75` raw box widths and up by `0.55` raw box heights, then scales height by `1.02`. If screenshots show drift, tune only the constants in `calibratedFaceBox` in `app.js`.
- Face-box offsets and gates must scale from the detected raw/calibrated box dimensions. Do not add fixed pixel offsets or fixed frame-percentage offsets for box correction, expansion, center acceptance, or motion thresholds; use multipliers such as `box.w * 0.1` or `box.h * 0.1`.
- `SHOW_FACE_DEBUG_BOX` in `app.js` controls whether the blue box appears in the real app. Keep it disabled for normal product flow.

### Hand Gestures

Hand gestures use MediaPipe Hands from `cdn.jsdelivr.net`. The server issues three gesture steps. The browser submits bounded evidence, and the server validates ordering, timing, session binding, and replay state. Step evidence may include optional `motionStats` (hold micro-jitter and forming-motion variance) with loose server bands.

Important gesture details:

- `three` means index, middle, and ring fingers up; thumb and pinky folded.
- `Hand Hearts` requires both hands. It is not a pinch.
- MediaPipe is configured with `maxNumHands: 2` because hand hearts need two hands.
- Hand step evidence may include bounded `landmarkSamples`; the server applies cheap geometry checks for gestures like `three` and `ily` when samples are present.

### Zoe ID

Zoe ID is the high-assurance repeat-use path. It is implemented as WebAuthn/passkeys in this demo. Passkey credentials persist per session in SQLite (a `hardware_backed` flag is stored alongside the credential).

Registration asks the authenticator for an attestation (`attestation: 'direct'`) and the client forwards `attestationObject` to `/api/passkey/register/verify`. The server parses the CBOR attestation object and:

- `packed`/`apple` with an x5c chain that verifies to an embedded FIDO root (Apple WebAuthn Root CA, Yubico U2F/FIDO/Attestation roots) marks the credential `hardwareBacked`.
- `fmt 'none'`, packed self-attestation, and x5c chains that don't reach a known root (Chrome/Android software keys emit self-signed leaves by design) still register but stay software-backed; malformed objects, malformed certs, invalid signatures, and unknown formats are 400s.
- Trust anchors live in `FIDO_ROOT_PEMS` in `server.js`; `ZOE_FIDO_ROOT_PEMS` (JSON array of PEMs) replaces them — tests inject a generated root.

Assurance on redeem: `hardwareBacked && userVerified` → `'strong'`; everything else → `'standard'`. A scripted software keypair can complete the whole Zoe ID lifecycle but caps at `'standard'` — the `attack:agent` scripted-Zoe-ID probe asserts exactly that.

Zoe ID registration must be gated. Do not blindly create a passkey just because the user clicked register:

- The user must first complete a fresh face or hand check.
- The Zoe ID registration UI starts with face verification. Hand verification can still unlock registration when the user intentionally completes that fallback first.
- `/api/passkey/register/options` requires `registrationVerificationToken`.
- Only `gesture` and `face-motion` verification tokens with `standard` assurance may unlock registration.
- Creating a passkey should not immediately act as proof of identity; future access uses `Use existing Zoe ID`.
- Do not build a Zoe ID portal in this demo. That is production scope.

There are multiple Zoe ID entry points:

- Desktop method-choice card.
- Mobile verification header button.

Keep those entry points routed through the Zoe ID intermediate page. Do not add Zoe ID back into alternate verification panels.

### Camera Help

Do not restore emergency text/audio verification, assisted verification, or a `Need another way?` fallback panel. When camera checks take a bit, Zoe should show passive camera guidance only while the user keeps trying the selected face or hand method.

## Security Boundaries

Keep these properties intact:

- Client-side claims alone must never verify the user.
- Server-issued verification tokens are short-lived and one-use.
- Challenge steps must be ordered and session-bound.
- Passkey assertions must verify against a server-issued challenge.
- Passkey registration must be gated by a fresh face or hand verification token.
- Flash fallback must reuse the exact accepted `mediaDigest`; it must never bypass or replace server-side presentation analysis.
- The camera lab must remain behind `ZOE_DEBUG=1` and must never issue tokens or alter verification thresholds.

The app is still a demo. For production, the README calls out remaining work including evaluated PAD thresholds and datasets, camera/device integrity signals, realistic replay and injection resistance, abuse monitoring, datastore-backed rate limits, deployment-specific CSRF/origin checks, secret management, and a complete accessibility policy.

## Branding

The product name is `Zoe`.

Avoid bringing back:

- `RealHands`
- `RealPresence`
- `RealPresence Relay`
- visible `RP` branding

The Git remote should be:

```text
https://github.com/embeputer/zoe.git
```

## Design Notes

The UI should stay compact and verification-first, styled like a hosted KYC widget (Persona/Veriff feel):

- No landing page.
- No marketing hero.
- No nested cards.
- Cards are for the info card, choice cards, and framed tools only.
- Avoid redundant explanatory copy after the intro card has already explained privacy/result sharing.
- Keep mobile uncluttered.
- Keep text fitting within buttons/cards at phone widths.

The current visual language (matched to Persona Relay / K-ID reference UIs, researched live in-browser): light page (`--page`), a white bordered card with large `--radius` 28px corners (`--shadow`), indigo used sparingly as an accent (`--blue`/`--blue-soft`), a persistent `.card-topbar` with the asterisk brand mark + lowercase `zoe` wordmark and segmented `.flow-steps` progress driven by `setFlowStep` inside `setCardMode` (intro→choice/id→verify→success = steps 1–4). Intro: lavender `--hero` hero with a Persona-style dashed-circle `.zoe-icon` face glyph, claim row with icon chip, navy `.privacy-panel` with SVG icon chips, then a near-black `--cta` primary `.intro-verify` button on the white card plus a `.legal-line` with linked Terms/Privacy. Choice rows: K-ID-style `.choice-card`s with `--chip` lavender icon chips, bold title, desc, `.choice-badge` outline pill, and `›` chevron. Primary buttons are near-black (`--cta`), secondaries are light-gray `--quiet` pills, ghosts are quiet text. SVG stroke icons inside `.choice-icon`/`.method-icon`/`.claim-icon`/`.privacy-icon` chips (deterministic — do not swap back to emoji glyphs for static icons; emoji remain for dynamic stream prompts), scan-corner brackets on `.video-wrap::after`, glass status pill, and an animated `.verified-icon` success state. `#flash-overlay` is a direct child of `<body>` (not inside the transformed `.captcha-card`) so `position:fixed` covers the real viewport. Keep new components consistent with this language.

## Editing Guidance

- Prefer small scoped edits.
- Use `rg` for search.
- Use `apply_patch` for manual file edits.
- Do not revert unrelated user changes.
- After JS/server changes, run:

```sh
node --check app.js
node --check server.js
node --check test_server.js
npm test
```

For CSS/HTML-only changes, at minimum search for stale copy and verify the relevant browser flow when practical.
