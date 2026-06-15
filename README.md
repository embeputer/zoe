# Zoe

Zoe is a small human-presence verification demo. The browser can run hand gesture checks or face-motion liveness locally, while the server owns challenge state, replay protection, and one-use verification tokens.

## Requirements

- Node.js 18 or newer
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

## Test

```sh
npm test
```

The regression test starts a temporary local HTTP server and checks that:

- fake client-side verification is rejected
- assisted-check requests do not create verification tokens
- emergency text/audio checks issue server-bound tokens only once per session
- empty Zoe ID sessions cannot authenticate a passkey
- out-of-order challenge steps are rejected
- valid challenge completion issues a token
- verification tokens are single-use

## How It Works

1. The browser asks the server for a challenge.
2. The user chooses a primary verification method, such as hand gestures or face motion.
3. The browser performs the local check and submits bounded evidence for that step.
4. The server validates order, timing, replay state, and session binding.
5. After all steps pass, the server issues a short-lived signed token.
6. The protected action accepts only that server-issued token, once.

## Accessibility And Bad Camera Conditions

The UI gives camera guidance when detection struggles. Users can choose a different primary method before verification:

- **Zoe ID**: strongest repeat-use path. Approved users verify with a passkey through WebAuthn, and the server verifies the signed assertion.
- **Face motion**: primary local face-motion check using the browser `FaceDetector` API when available. It checks simple motion, not identity.

During camera verification, **Need another way?** is emergency-only:

- **Emergency text**: one-use typed challenge for a user who is stuck right now. It issues an `emergency` assurance token and should only be accepted for low-risk actions.
- **Emergency audio**: one-use spoken code using the browser's speech synthesis, then typed back by the user. It uses the same low-assurance emergency policy.

The older assisted-request endpoint still exists as a safe queue-shaped stub: it creates a tracked request id, but does not issue a verification token.

For a real no-hassle accessibility path, users should apply for a manual review through Zoe ID. Once approved, they can add a passkey and use that high-assurance path instead of repeating emergency text or audio.

## Security Notes

This patch fixes the original client-side trust-boundary problem, but it is still a demo. For high-value production use, add server-side media verification, abuse monitoring, durable storage, passkey credentials stored on user accounts instead of in memory, rate limits backed by a real datastore, secret management, CSRF/origin enforcement tuned to your deployment, and a fully designed accessibility fallback policy.
