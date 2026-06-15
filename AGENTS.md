# Agent Notes

## Project

Zoe is a server-bound human verification demo. The browser runs local camera checks for face motion or hand gestures, but the server owns challenge state, replay protection, passkey verification, fallback challenges, and one-use verification tokens.

This is a plain Node/static app:

- `server.js` serves files and implements all API routes.
- `app.js` owns browser UI state, MediaPipe hand detection, face-motion checks, passkey calls, and fallback UI.
- `index.html` is the single page.
- `styles.css` is the complete UI styling.
- `test_server.js` is the regression/security test suite.

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

Do not reintroduce a fake phone frame. The design is inspired by the card inside a Persona Relay-style flow, not by rendering a whole phone mockup.

## Verification Methods

### Face Motion

Face motion is the default on mobile. It uses the browser `FaceDetector` API when available. It is a liveness-style motion check, not identity verification.

### Hand Gestures

Hand gestures use MediaPipe Hands from `cdn.jsdelivr.net`. The server issues three gesture steps. The browser submits bounded evidence, and the server validates ordering, timing, session binding, and replay state.

Important gesture details:

- `three` means index, middle, and ring fingers up; thumb and pinky folded.
- `Hand Hearts` requires both hands. It is not a pinch.
- MediaPipe is configured with `maxNumHands: 2` because hand hearts need two hands.

### Zoe ID

Zoe ID is the high-assurance repeat-use path. It is implemented as WebAuthn/passkeys in this demo. Passkey credentials are stored in memory on the session, not in durable accounts.

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
