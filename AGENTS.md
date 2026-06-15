# Agent Notes

## Project

Zoe is a server-bound human verification demo. The browser runs local camera checks for face motion or hand gestures, but the server owns challenge state, replay protection, passkey verification, fallback challenges, and one-use verification tokens.

This is a plain Node/static app:

- `server.js` serves files and implements all API routes.
- `app.js` owns browser UI state, MediaPipe hand detection, face-motion checks, passkey calls, and fallback UI.
- `index.html` is the single page.
- `styles.css` is the complete UI styling.
- `test_server.js` is the regression/security test suite.
- `face-debug.html` + `face-debug.js` are a dev-only camera/model debugger.

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

For isolated face detector debugging, use:

```sh
npm run dev
```

This starts `dev_face_debug.js`, serves `face-debug.html` (default `http://127.0.0.1:3010/face-debug.html`), opens the browser, and draws raw Blaze detections/keypoints/confidence over the camera feed without running the full verification flow. Use `PORT=3020 npm run dev` to pick another port.

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

Face motion is the default on mobile. It runs cross-browser using MediaPipe Tasks Vision (`@mediapipe/tasks-vision`), imported dynamically in `app.js`. The WASM runtime loads from `cdn.jsdelivr.net`, and the active compatible short-range FaceDetector model is vendored locally at `models/blaze_face_short_range.tflite` and served from the same origin. The Tasks Vision FaceDetector is the active gate because it exposes confidence scores and a conventional bounding box; the browser validates confidence, size/aspect, and target-oval position before counting motion. The older `@mediapipe/face_detection` Solutions build is intentionally avoided because it evaluates strings as JavaScript and would require loosening the CSP. The browser's non-standard `FaceDetector` API is used only as an opportunistic fallback when the MediaPipe runtime cannot load. It is a liveness-style motion check, not identity verification.

The face check is a guided flow (`runGuidedFaceCheck` in `app.js`): it draws a target oval on the overlay canvas, then walks the user through center → move left → move right with changing prompt text and a directional arrow. This horizontal sweep produces the motion the server requires. The Zoe app camera starts unmirrored on purpose for both face and hand checks, so detector coordinates, video frames, and overlays all share one coordinate space. Do not re-add `scaleX(-1)`, `ctx.scale(-1, 1)`, or scattered x-flips to the app camera/overlay unless the coordinate mapping is changed and verified in the app and `npm run dev`.

Known face-detector findings:

- `models/blaze_face_short_range.tflite` is the compatible active model. The browser debug page has shown it can detect the user's face around ~86-87% confidence.
- `models/blaze_face_full_range.tflite` was tested and is incompatible with the Tasks FaceDetector graph in this app (`raw_box_tensor ... 2304 vs 896`). Do not reintroduce it unless the graph/model compatibility is proven first.
- `models/face_landmarker.task` was removed from the active path because the landmarker-only approach could hallucinate a mesh on shoulder/neck/background skin without a usable per-face confidence score.
- Keep the face logic boring: detector output → one centralized box calibration (`calibratedFaceBox`) → size/oval gates → explicit center/left/right state machine. The default coordinate mode is unmirrored (`displayedFaceX(box) === box.cx`). Do not stack ad hoc keypoint-derived boxes, scattered `1 - box.cx` conversions, or extra draw-only offsets.
- `calibratedFaceBox` currently shifts the raw Blaze box left by `0.75` raw box widths and up by `0.55` raw box heights, then scales height by `1.02`. If screenshots show drift, tune only the constants in `calibratedFaceBox` in both `app.js` and `face-debug.js`.
- Face-box offsets and gates must scale from the detected raw/calibrated box dimensions. Do not add fixed pixel offsets or fixed frame-percentage offsets for box correction, expansion, center acceptance, or motion thresholds; use multipliers such as `box.w * 0.1` or `box.h * 0.1`.
- `SHOW_FACE_DEBUG_BOX` in `app.js` controls whether the blue box appears in the real app. Prefer `npm run dev` for detailed debugging instead of adding temporary browser-console snippets.

### Hand Gestures

Hand gestures use MediaPipe Hands from `cdn.jsdelivr.net`. The server issues three gesture steps. The browser submits bounded evidence, and the server validates ordering, timing, session binding, and replay state.

Important gesture details:

- `three` means index, middle, and ring fingers up; thumb and pinky folded.
- `Hand Hearts` requires both hands. It is not a pinch.
- MediaPipe is configured with `maxNumHands: 2` because hand hearts need two hands.

### Zoe ID

Zoe ID is the high-assurance repeat-use path. It is implemented as WebAuthn/passkeys in this demo. Passkey credentials are stored in memory on the session, not in durable accounts.

Zoe ID registration must be gated. Do not blindly create a passkey just because the user clicked register:

- The user must first complete a fresh face or hand check.
- `/api/passkey/register/options` requires `registrationVerificationToken`.
- Only `gesture` and `face-motion` verification tokens with `standard`/`fallback` assurance may unlock registration.
- Emergency text/audio tokens must not register Zoe ID.
- Do not show `Need another way?` emergency checks while Zoe ID registration is waiting for face/hand verification.
- Creating a passkey should not immediately act as proof of identity; future access uses `Use existing Zoe ID`.
- Do not build a Zoe ID portal in this demo. That is production scope. Current copy may reference production manual review, but there should be no portal route/UI yet.

There are multiple Zoe ID entry points:

- Desktop method-choice card.
- Mobile verification header button.

Keep those entry points routed through the Zoe ID intermediate page. Do not put Zoe ID back inside the `Need another way?` emergency panel.

### Emergency Text And Audio

Emergency text/audio are low-assurance, one-use fallbacks. They should be treated as emergency access only, not as ordinary verification.

The public fallback API should only expose:

- `emergency_text`
- `emergency_audio`

Do not restore plain `text` or `audio` as normal fallback modes.

## Security Boundaries

Keep these properties intact:

- Client-side claims alone must never verify the user.
- Server-issued verification tokens are short-lived and one-use.
- Challenge steps must be ordered and session-bound.
- Assisted/accessibility request IDs are not verification tokens.
- Emergency fallback is one-use per session.
- Passkey assertions must verify against a server-issued challenge.
- Passkey registration must be gated by a fresh non-emergency verification token.

The app is still a demo. For production, the README already calls out needed upgrades: durable storage, real account-backed passkeys, server-side media verification or stronger liveness, abuse monitoring, datastore-backed rate limits, deployment-specific CSRF/origin checks, secret management, and a complete accessibility fallback policy.

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

The UI should stay compact and verification-first:

- No landing page.
- No marketing hero.
- No nested cards.
- Cards are for the info card, choice cards, and framed tools only.
- Avoid redundant explanatory copy after the intro card has already explained privacy/result sharing.
- Keep mobile uncluttered.
- Keep text fitting within buttons/cards at phone widths.

Use the existing palette and component style unless there is a strong reason to change it.

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
