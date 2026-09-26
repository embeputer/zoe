---
name: testing-zoe-liveness
description: How to test Zoe's camera-liveness and Zoe ID passkey flows on a VM with no camera and no security key — isolated Xvfb Chrome + CDP-driven camera/face emulation + CDP virtual authenticator, plus ffmpeg screen capture.
---

# Testing Zoe liveness without a camera

## Environment

- Run the app with `npm start` (plain node, zero npm deps, needs node >= 22.5). `PORT` env overrides; `3000` and `3123` may both be in use — check `ss -tln` first. The app MUST be served over http (file:// is rejected by design).
- This VM has **no camera** (`/dev/video*` absent). `getUserMedia` rejects `NotFoundError` → UI shows `Error` + "Requested device not found" with a working "Start check" retry. That degradation path is valid test evidence by itself.
- **Use `http://localhost:<port>`, not `http://127.0.0.1:<port>`, when testing passkeys** — IP literals are not valid WebAuthn RP IDs; `navigator.credentials.*` throws `SecurityError: invalid domain` on 127.0.0.1 while the server accepts both origins.
- The shared Devin Chrome (its `--remote-debugging-port` is on its cmdline; check `ps aux | grep remote-debugging-port`) is **contended** — other sessions may navigate your tab mid-run. Launch your own instead:
  ```
  Xvfb :1 -screen 0 1280x960x24 &
  DISPLAY=:1 google-chrome --user-data-dir=/tmp/prof --remote-debugging-port=29230 \
    --no-first-run --start-maximized "http://localhost:3125" &
  ffmpeg -y -f x11grab -video_size 1280x960 -framerate 15 -i :1 -c:v libx264 -preset veryfast -pix_fmt yuv420p /tmp/rec.mp4
  ```
- For real MediaPipe Tasks Vision in the VM, launch Chrome with `--ignore-gpu-blocklist --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader-webgl`. Without these flags, `detectForVideo` may throw from `_glActiveTexture` before the page updates its face status.
- Drive it via CDP `Runtime.evaluate` — node 24's built-in `WebSocket` works (no deps); get the page WS URL from `http://localhost:<port>/json/list`. `el.click()` fires real handlers; `Page.captureScreenshot` gives PNGs; extract flash frames with `ffmpeg -ss <t> -frames:v 1`.
- `Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot` gives clean phone-width screenshots without resizing the window.
- Debug page overlay assertions: `debug.css` mirrors BOTH `video` and `#overlay` via `transform: scaleX(-1)`. To verify the drawn face rect objectively, scan the overlay canvas pixels for the green stroke `#56e39f` — rect edges are long straight runs (>80px); the dashed target ellipse contributes only short runs. Rect coords are in SOURCE frame space; the rendered rect appears mirrored. The debug pulse ROI is derived from the calibrated face box (`face.x + 0.3w`, `face.y + 0.12h`, `0.4w × 0.18h`) — it MOVES when the box math changes, so keep the emulated green modulation strip covering the ROI or the debug "Heartbeat found" path won't engage (it is not gated by, but does demonstrate, live sampling).

## Emulating a camera end-to-end (face liveness = motion + pulse + flash)

`app.js` top-level functions are window globals — override via `Runtime.evaluate`:
- `navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(15)` where a rAF loop paints a dark scene + skin ellipse + coarse noise (~32x24 noise grid survives the 12x9 downscale; keep adjacent-frame L1 in [0.3, 90]).
- **Pulse stage** (`runPulseCheck`, samples the FOREHEAD ROI = top ~5-16% of `box.pixelBox`, green channel only): give the face ellipse a cardiac-band green modulation — `g = 115 + 6·sin(2π·1.17t) + 2.2·sin(2π·2.34t + 0.7) + small drift`. The server FFT gate needs a peak in 0.8–2.4Hz with `lobeFraction` in [0.45, 0.97] — **a pure sine fails as 'synthetic'**, a fundamental + in-band 2nd harmonic + noise lands ~0.8. Draw background noise UNDER the ellipse and only a light noise pass over the face, or the pulse drowns.
- **Pulse now samples in the background** during center_hold + every motion phase (`collectPulse`, ~9Hz cap 300). The hold-still stage is only a top-up: `max(5s, 14000 - lastBgSample.t)` (reduced-motion: `max(9s, 20000 - t)`). Server keeps ≥9s total span but analyzes only the last-minSpan tail. To measure: `pulseSeries` timestamps are **flow-relative** (t0 = `runGuidedFaceCheck` start ≈ 'Get ready'), while prompt changes use raw `performance.now()` — subtract the flow-start offset before comparing. Emulated turns need realistic durations (~2-6s `__turnMs`) or motion finishes in ~1s and the top-up stays ~13s.
- **Stage boundaries**: watch `#prompt-gesture` (the EMOJI element — `#prompt-emoji` does NOT exist) — 💓 = pulse stage, 💡 = flash stage; both set `#prompt-name` = 'Hold still' so name alone can't separate them.
- For flash-correlated pixels, read `document.getElementById('flash-overlay').style.background` each frame and wash the canvas toward it (alpha ~0.55–0.68 — keep pulse amplitude small so it doesn't fight the color-tracking cosine). Toggle a flag to also produce the *uncorrelated* case → server should 400 "Face pixels did not reflect the issued flash sequence."
- `window.ensureFaceEngine = async () => 'mediapipe'` and `window.detectStableFaceFrame = async () => box` where `box = {cx, cy, w, h, score, pixelBox:{x,y,w,h} (px), pose:{pose:'center'|'left'|'right', yaw}, keypoints, stale:false}`. Drive poses off `document.getElementById('prompt-name').textContent` ('Center your face'/'Turn left'/'Turn right'/'Hold still'); animate ~500ms per turn, add yaw jitter σ≈0.012 (server needs jitter ≥0.00035, tortuosity >1.004, 150ms≤transition≤14s, ≥3 samples/phase, yaw range ≥0.35).
- Wrap `window.fetch` to record per-path `{status, body}` into `window.__api` for assertions.
- This keeps everything else real: challenge POST, phase machine, prompts/progress UI, `runPulseCheck`/`runFlashPixelCheck`, `setFlashOverlay` (visible flashes), `sampleFlashPixels`→base64, verify POST, token + protected action.
- **Wall-clock floor**: `/api/liveness/verify` rejects if real elapsed since challenge < `ZOE_LIVENESS_MIN_ELAPSED_MS` (default 14000; 19000 for reducedMotion). The real flow satisfies it via the 14s pulse; API scripts must actually `sleep(14500)` between challenge and verify. `ZOE_STEP_MIN_ELAPSED_MS` (default 180) floors each gesture step.
- **Zoe ID register path needs `selectPrimaryMethod('face')` first on desktop** — `selectedPrimaryMethod` defaults to `'hand'` (top of `app.js`), and the hand flow loads real MediaPipe Hands → **blocking `alert()` "Failed to create WebGL canvas context"** on this VM which wedges the whole page/CDP. Auto-accept dialogs: handle `Page.javascriptDialogOpening` → `Page.handleJavaScriptDialog {accept:true}`.

## Zoe ID / WebAuthn testing via CDP virtual authenticator

- `WebAuthn.enable` then `WebAuthn.addVirtualAuthenticator {options:{protocol:'ctap2', transport:'internal', hasResidentKey:true, hasUserVerification:true, isUserVerified:true, isUserConsenting:true, automaticPresenceSimulation:true}}` — **`transport:'internal'` only**: `'usb'` opens Chrome's native "Insert your security key" sheet that a virtual device can't satisfy, and `credentials.create`/`get` hang forever.
- The authenticator lives in the ws session — **if your script dies mid-ceremony the pending request orphans** and every later `create` throws `OperationError: A request is already pending` (survives page reload). Recovery: restart Chrome with a fresh `--user-data-dir`, or click Cancel on the native sheet via `DISPLAY=:1 xdotool mousemove 694 404 click 1`.
- Chrome's virtual authenticator emits `fmt:'packed'` + `attStmt:{alg,sig,x5c:[self-signed per-credential "Chromium Batch Certificate"]}`. Zoe's server **hard-400s untrusted x5c chains** ("Passkey attestation chain is not trusted.") — so a virtual authenticator can never complete `attestation:'direct'` registration as-is.
- To exercise the software path end-to-end, rewrite the register/options RESPONSE at the fetch boundary: `attestation:'direct' → 'none'` → the authenticator emits a real `fmt:'none'` object → registers → `assurance:'standard'`.
- To prove the `hardwareBacked → 'strong'` path, mint your own root+leaf (openssl, leaf `basicConstraints=CA:FALSE`), inject the root via `ZOE_FIDO_ROOT_PEMS='["<pem>"]'` server env, and craft a packed attestationObject (CBOR `{fmt:'packed', attStmt:{alg:-7, sig:sign(leaf, authData+sha256(cdj)), x5c:[leafDER, rootDER]}, authData}` with rpIdHash=sha256(origin-host), flags 0x45, aaguid+credId+COSE key) — then sign the auth assertion with the embedded credential key → `/api/verify` redeems `'strong'`.
- Tokens: `zoe.verification` is a 2-part `payloadB64.sigB64` — `JSON.parse(Buffer.from(t.split('.')[0],'base64url'))` reads `assurance`/`method`. `/api/verify` redeems without a session cookie but consumes the token (one-use) — redeem a SECOND minted token if you also want the UI's protected-action path intact.
- Rate limits: 60/min per session + 120/min per IP — pace scripted API loops.

## API-level checks (no browser)

- `POST /api/liveness/challenge` → 201 `{challengeId, plan[3], flashPlan[4x{c,o,d}]}`; sets `zoe_sid` (HttpOnly, SameSite=Strict) — carry the cookie + `Origin` header on subsequent calls.
- `/api/liveness/verify` needs valid `motionSeries`+`seriesDigest` (`sha256(challengeId + '\n' + JSON.stringify(motionSeries))`) plus `pulseSeries` (FFT-gated) and `pixelSeries`; `attack_server.js` has proven fabricators (`fabricatedMotionSeries`, `fabricatedPixelSeries`, `fabricatedPulseSeries`, `attackerSeriesDigest`).
- `/api/passkey/register/options` requires a one-use `registrationVerificationToken` (face-motion/gesture, 'standard' only) — gate returns 401 without it.

## Gotchas

- **`validateFlashFrames` first-frame guard** (bug at 12b1291, fixed 6df2713): the min-gap check `t - previousT < 120` originally lacked the `previousT >= 0` skip that `validatePresentationFrames` has — a first baseline frame <120ms in always 400'd 'too close together'. If a checkout still lacks the guard, return `stale:true` for the first ~160ms of the flash stage so the first capture lands ≥120ms.
- **Presentation min-face-size vs square crops**: `serverDetectsClaimedFace` requires the detected face `clippedWidth >= 48*1.5*(640/srcH)` det-px (was 2x pre-6df2713). The claim `pixelBox` must **tightly bound the actual rendered face** (the 1.8x crop grows from the claim — a box 2.4x wider than the face shrinks the detected fraction below the gate → 'photo or screen'). Keep the claim's bottom inside the canvas too: the square crop clamps to frame edges, which can push the normalized `face` out of bounds → 'Camera media face box is invalid.'
- **Pulse binding needs the modulated region inside the claim box**: `validatePulseFrameBinding` correlates mediaFrame face-green means with the pulse claims — the emulated modulation strip should cover the forehead pulse ROI AND a good fraction (~40%+) of the claimed face box or correlation falls short → 422 even with a clean FFT signal.
- **`validatePixelSeries` needs per-frame noise**: baseline samples must satisfy meanL1∈[0.3,90] AND ≥60% of adjacent samples differing, else 'Pixel stream repeats identical frames'. A static canvas scene fails — add a per-frame random-alpha gray wash over the whole canvas AND use `captureStream(30)` (at 15fps the ~66ms frame cadence lets consecutive ~70ms samples read identical video frames).
- **Debug overlay mirroring**: `debug.css` applies `scaleX(-1)` to the canvas; if `debug.js drawFace` also mirrors in JS (`width - x - w`) the rect lands on the WRONG side (double mirror). Verify drawn-vs-displayed alignment with the green-scan, and confirm which layer owns the mirror.
- Flash frames are ~220-340ms with gaps — poll fast or extract frames from a recording rather than relying on one screenshot.
- If the face is lost mid-flash, samples lack `f` → baseline/window counts can fall below minimums → honest user gets 400 (false-reject edge worth knowing).
- `git status` for the branch; `zoe-kyc-ui/` may also exist on the box — a different repo, do not confuse the two servers.
- Kill processes by explicit PID — `pkill -f '<pattern>'` matches the invoking shell's own cmdline and kills your exec call.
- Restarted `node server.js` picks up edited code; a long-running server serves stale code after repo changes.

## Devin Secrets Needed

- None.
