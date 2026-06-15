# RealHands

RealHands is a small hand-gesture verification demo. The browser runs MediaPipe hand detection locally, while the server owns challenge state, replay protection, and one-use verification tokens.

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
- out-of-order challenge steps are rejected
- valid challenge completion issues a token
- verification tokens are single-use

## How It Works

1. The browser asks the server for a challenge.
2. The server returns one gesture step at a time.
3. The browser detects the gesture locally and submits bounded evidence for that step.
4. The server validates order, timing, replay state, and session binding.
5. After all steps pass, the server issues a short-lived signed token.
6. The protected action accepts only that server-issued token, once.

## Accessibility And Bad Camera Conditions

The UI gives camera guidance when detection struggles. Users can also choose **Need another way?** to request an assisted check.

The assisted path is deliberately not an automatic bypass. It creates a tracked request id for a future higher-trust fallback, such as human review, passkey step-up, or support-assisted verification. It does not issue a verification token by itself.

## Security Notes

This patch fixes the original client-side trust-boundary problem, but it is still a demo. For high-value production use, add server-side media verification, abuse monitoring, durable storage, rate limits backed by a real datastore, secret management, CSRF/origin enforcement tuned to your deployment, and a fully designed accessibility fallback policy.
