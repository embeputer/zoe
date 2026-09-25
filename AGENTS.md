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

Sessions, passkey credentials, and consumed token digests persist in SQLite (`node:sqlite`, file `zoe-data.sqlite3`, override with `ZOE_DB_PATH`; tests use `:memory:` or a temp file). Short-lived challenge state stays in memory. Relying parties redeem tokens via `POST /api/verify` (signature + expiry + one-use; no session cookie required).

## Run And Test

Use:

```sh
npm start
npm test
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

The face check is a guided flow (`runGuidedFaceCheck` in `app.js`): it draws a target oval on the overlay canvas, follows the server-issued liveness plan from `POST /api/liveness/challenge` (always `center_hold`, then either `center_to_left` → `left_to_right` or `center_to_right` → `right_to_left`), then runs `runFlashPixelCheck` — a full-screen random color-flash sequence (`#flash-overlay`) while timestamped face-region pixel bursts are uploaded as `pixelSeries`. The server verifies reflected light tracks the issued `flashPlan` (per-flash color-delta cosine + magnitude, baseline sensor noise, coverage). This raises attack cost but stays forgeable — see `attack_server.js`. The app counts keypoint yaw poses (`center`, `left`, `right`) instead of only box translation, then submits yaw-range motion evidence plus phase-tagged micro-jitter/tortuosity summaries, a bounded `motionSeries`, and a `seriesDigest` bound to `challengeId`. Optional quantized mouth/ear span samples may be included when Blaze keypoints are available.

Known face-detector findings:

- `models/blaze_face_short_range.tflite` is the compatible active model. Prior browser debugging showed it can detect the user's face around ~86-87% confidence.
- `models/blaze_face_full_range.tflite` was tested and is incompatible with the Tasks FaceDetector graph in this app (`raw_box_tensor ... 2304 vs 896`). Do not reintroduce it unless the graph/model compatibility is proven first.
- `models/face_landmarker.task` was removed from the active path because the landmarker-only approach could hallucinate a mesh on shoulder/neck/background skin without a usable per-face confidence score.
- Keep the face logic boring: detector output → one centralized box calibration (`calibratedFaceBox`) → size/oval gates → eye/nose keypoint yaw → explicit center/left/right state machine. The default coordinate mode is unmirrored (`displayedFaceX(box) === box.cx`). Do not stack ad hoc keypoint-derived boxes, scattered `1 - box.cx` conversions, or extra draw-only offsets.
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

Zoe ID is the high-assurance repeat-use path. It is implemented as WebAuthn/passkeys in this demo. Passkey credentials are stored in memory on the session, not in durable accounts.

Zoe ID registration must be gated. Do not blindly create a passkey just because the user clicked register:

- The user must first complete a fresh face or hand check.
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

The app is still a demo. For production, the README already calls out needed upgrades: durable storage, real account-backed passkeys, server-side media verification or stronger liveness, abuse monitoring, datastore-backed rate limits, deployment-specific CSRF/origin checks, secret management, and a complete accessibility policy.

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
