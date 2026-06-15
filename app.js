// Zoe - human-presence verification.
// The browser performs local hand-pose detection, but the server owns
// challenge order, replay state, and the final verification token.

const HOLD_FRAMES = 8;
const COOLDOWN_MS = 1200;
const FRAME_SAMPLE_MS = 33;

let stream = null;
let handsModel = null;
let faceModel = null;
let legacyFaceDetector = null;
let faceChecking = false;
let verificationStarting = false;
let rafId = null;
let detecting = false;
let submittingStep = false;

let currentChallengeId = null;
let currentStep = null;
let totalSteps = 3;
let completedSteps = 0;
let holdCounter = 0;
let cooldownUntil = 0;
let lastFrameTs = 0;
let stepStartedAt = 0;
let framesSinceStep = 0;
let landmarkSamples = [];
let motionSamples = [];
let verificationToken = null;
let noHandFrames = 0;
let noMatchFrames = 0;
let lastHelpMessageAt = 0;
let selectedPrimaryMethod = 'hand';
let zoeIdReturnTarget = 'choice';
let pendingZoeIdRegistration = false;
let pendingZoeIdResultEl = null;

const $ = (id) => document.getElementById(id);

const videoEl = $('video');
const canvasEl = $('overlay');
const ctx = canvasEl.getContext('2d');
const statusEl = $('status-pill');
const promptEmojiEl = $('prompt-gesture');
const promptNameEl = $('prompt-name');
const promptHintEl = $('prompt-hint');
const progressEl = $('progress-bar');
const methodHandBtn = $('method-hand-btn');
const methodFaceBtn = $('method-face-btn');
const verificationTitleEl = $('verification-title');
const startBtn = $('start-btn');
const resetBtn = $('reset-btn');
const cardEl = $('captcha-card');
const panelShellEl = $('panel-shell');
const zoeIntroEl = $('zoe-intro');
const zoeVerifyBtn = $('zoe-verify-btn');
const methodChoiceEl = $('method-choice');
const choiceFaceBtn = $('choice-face-btn');
const choiceHandBtn = $('choice-hand-btn');
const choiceIdBtn = $('choice-id-btn');
const choiceResultEl = $('choice-result');
const zoeIdPanel = $('zoe-id-panel');
const idUseBtn = $('id-use-btn');
const idRegisterBtn = $('id-register-btn');
const idBackBtn = $('id-back-btn');
const idResultEl = $('id-result');
const dialogEl = $('dialog');
const verifiedEl = $('verified');
const mobileIdBtn = $('mobile-id-btn');
const assistBtn = $('assist-btn');
const assistPanel = $('assist-panel');
const textChallengeBtn = $('text-challenge-btn');
const audioChallengeBtn = $('audio-challenge-btn');
const fallbackForm = $('fallback-form');
const fallbackLabel = $('fallback-label');
const fallbackAnswer = $('fallback-answer');
const audioRepeatBtn = $('audio-repeat-btn');
const fallbackSubmitBtn = $('fallback-submit-btn');
const assistResultEl = $('assist-result');
const cameraHelpEl = $('camera-help');
const cameraHelpTextEl = $('camera-help-text');
const checkEls = Array.from(document.querySelectorAll('.check'));

let activeFallbackChallenge = null;

const LM = {
  thumbTip: 4, thumbIp: 3, thumbMcp: 2, thumbCmc: 1,
  indexMcp: 5, indexPip: 6, indexDip: 7, indexTip: 8,
  middleMcp: 9, middlePip: 10, middleDip: 11, middleTip: 12,
  ringMcp: 13, ringPip: 14, ringDip: 15, ringTip: 16,
  pinkyMcp: 17, pinkyPip: 18, pinkyDip: 19, pinkyTip: 20,
  wrist: 0,
};

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fingerExtended(lm, tip, pip) {
  return lm[tip].y < lm[pip].y - 0.02;
}

function thumbExtended(lm) {
  const tip = lm[LM.thumbTip];
  const ip = lm[LM.thumbIp];
  const cmc = lm[LM.thumbCmc];
  const idxMcp = lm[LM.indexMcp];

  const sideExtent = Math.abs(tip.x - cmc.x) > 0.10;
  const tipNotFolded = tip.y < idxMcp.y + 0.02;
  const ipAboveBase = ip.y < cmc.y + 0.05;
  return sideExtent && tipNotFolded && ipAboveBase;
}

function classifyGesture(lm) {
  const index = fingerExtended(lm, LM.indexTip, LM.indexPip);
  const middle = fingerExtended(lm, LM.middleTip, LM.middlePip);
  const ring = fingerExtended(lm, LM.ringTip, LM.ringPip);
  const pinky = fingerExtended(lm, LM.pinkyTip, LM.pinkyPip);
  const thumb = thumbExtended(lm);
  const okDist = dist(lm[LM.thumbTip], lm[LM.indexTip]);

  if (index && middle && ring && pinky && thumb) return 'open_palm';
  if (okDist < 0.05 && middle && ring && pinky) return 'ok';
  if (!thumb && index && !middle && !ring && pinky) return 'rock';
  if (!thumb && index && middle && ring && !pinky) return 'three';
  if (thumb && !index && !middle && !ring && pinky) return 'call_me';
  if (index && middle && !ring && !pinky) return 'peace';
  if (index && !middle && !ring && !pinky) return 'point';
  if (!index && !middle && !ring && !pinky && !thumb) return 'fist';
  return null;
}

function detectTwoHandHeart(hands) {
  if (hands.length < 2) return false;

  for (let i = 0; i < hands.length; i++) {
    for (let j = i + 1; j < hands.length; j++) {
      const left = hands[i];
      const right = hands[j];
      const thumbTipsTouch = dist(left[LM.thumbTip], right[LM.thumbTip]) < 0.10;
      const indexTipsTouch = dist(left[LM.indexTip], right[LM.indexTip]) < 0.10;
      const wristsSeparated = dist(left[LM.wrist], right[LM.wrist]) > 0.12;
      const leftFingerGap = dist(left[LM.thumbTip], left[LM.indexTip]) > 0.05;
      const rightFingerGap = dist(right[LM.thumbTip], right[LM.indexTip]) > 0.05;
      const indexPairY = (left[LM.indexTip].y + right[LM.indexTip].y) / 2;
      const thumbPairY = (left[LM.thumbTip].y + right[LM.thumbTip].y) / 2;
      const indexPairAboveThumbs = indexPairY < thumbPairY + 0.08;

      if (
        thumbTipsTouch &&
        indexTipsTouch &&
        wristsSeparated &&
        leftFingerGap &&
        rightFingerGap &&
        indexPairAboveThumbs
      ) {
        return true;
      }
    }
  }

  return false;
}

let waveHistory = [];
const WAVE_WINDOW_MS = 1500;
const WAVE_MIN_AMPLITUDE = 0.06;
let waveMatched = false;

function detectWave(lm) {
  const now = performance.now();
  const wrist = lm[LM.wrist];
  waveHistory.push({ x: wrist.x, t: now });
  waveHistory = waveHistory.filter((p) => now - p.t < WAVE_WINDOW_MS);
  if (waveHistory.length < 6) return false;

  const xs = waveHistory.map((p) => p.x);
  if (Math.max(...xs) - Math.min(...xs) < WAVE_MIN_AMPLITUDE) return false;

  let swings = 0;
  let prevDir = 0;
  for (let i = 1; i < waveHistory.length; i++) {
    const dir = Math.sign(waveHistory[i].x - waveHistory[i - 1].x);
    if (dir !== 0 && dir !== prevDir) {
      swings++;
      prevDir = dir;
    }
  }
  return swings >= 4;
}

async function initMediaPipe() {
  handsModel = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
  });
  handsModel.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  handsModel.onResults(onResults);
}

// MediaPipe Tasks Vision: cross-browser face detection that runs under a strict
// CSP (only needs 'wasm-unsafe-eval'). The WASM runtime loads from the CDN; the
// model is vendored locally so no extra connect-src origin is required.
const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const TASKS_VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const FACE_DETECTOR_MODEL_URL = '/models/blaze_face_short_range.tflite';

// Use the dedicated FaceDetector as the acceptance gate because it exposes a
// confidence score and a conventional bounding box. The previous landmarker-only
// path could hallucinate a canonical mesh on non-face skin without a reliable
// per-face confidence score, which is what caused shoulder/neck false locks.
async function initFaceDetection() {
  const vision = await import(TASKS_VISION_URL);
  const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
  const detector = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_DETECTOR_MODEL_URL },
    runningMode: 'VIDEO',
    // Keep model recall high; the app-level size/position gates below handle
    // obvious false positives.
    minDetectionConfidence: 0.5,
  });
  faceModel = detector;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera API not available in this browser. Use Chrome/Safari/Firefox on https or localhost.');
  }

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  videoEl.srcObject = stream;

  await new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    videoEl.addEventListener('playing', finish, { once: true });
    videoEl.addEventListener('error', () => reject(new Error('Video element error.')), { once: true });
    setTimeout(() => {
      if (!done) reject(new Error('Camera stream started but video never played.'));
    }, 5000);
    videoEl.play().catch(() => {});
  });

  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;
}

async function apiJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function base64urlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function setStartButton(label, disabled) {
  startBtn.disabled = !!disabled;
  startBtn.textContent = label;
  // While a check is running/initializing the button is just a redundant disabled
  // label (the status pill already shows progress), so hide it. It returns as the
  // "Start check" retry button once it's actionable again.
  startBtn.hidden = !!disabled;
}

function showError(msg) {
  setStatus('Error', 'error');
  promptHintEl.textContent = msg;
  setStartButton('Start check', false);
  if (pendingZoeIdRegistration) {
    pendingZoeIdRegistration = false;
    pendingZoeIdResultEl = null;
    setAssistButtonsDisabled(false);
  }
}

function showCameraHelp(message) {
  const now = performance.now();
  if (now - lastHelpMessageAt < 2500 && !cameraHelpEl.hidden) return;
  cameraHelpTextEl.textContent = message;
  cameraHelpEl.hidden = false;
  lastHelpMessageAt = now;
}

function hideCameraHelp() {
  cameraHelpEl.hidden = true;
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 560px)').matches;
}

const PANEL_TRANSITION_MS = 440;
let panelTransitionTimer = null;

function setCardMode(mode) {
  cardEl.classList.toggle('choice-mode', mode === 'choice');
  cardEl.classList.toggle('id-mode', mode === 'id');
  cardEl.classList.toggle('verify-mode', mode === 'verify');
  cardEl.classList.toggle('success-mode', mode === 'success');
}

function transitionToPanel(activePanel, mode, focusEl, direction = 'forward') {
  const panels = [zoeIntroEl, methodChoiceEl, zoeIdPanel, dialogEl, verifiedEl];
  if (panelTransitionTimer) window.clearTimeout(panelTransitionTimer);
  const outgoingPanel = panels.find((panel) => !panel.hidden && panel !== activePanel);
  const outgoingHeight = outgoingPanel ? outgoingPanel.offsetHeight : panelShellEl.offsetHeight;

  cardEl.classList.toggle('swipe-back', direction === 'back');
  panelShellEl.classList.remove('is-transitioning', 'is-animating');
  panelShellEl.style.height = `${Math.max(1, outgoingHeight)}px`;

  panels.forEach((panel) => {
    const isOutgoing = panel === outgoingPanel;
    if (panel === activePanel || isOutgoing) panel.hidden = false;
    panel.classList.toggle('panel-exiting', isOutgoing);
    panel.classList.toggle('panel-entering', panel === activePanel && panel !== outgoingPanel);
    if (panel === activePanel) {
      panel.classList.remove('panel-exiting');
      panel.removeAttribute('aria-hidden');
    } else {
      panel.setAttribute('aria-hidden', 'true');
    }
  });

  requestAnimationFrame(() => {
    setCardMode(mode);
    panelShellEl.classList.add('is-transitioning');
    panelShellEl.style.height = `${Math.max(1, activePanel.offsetHeight)}px`;
    fitCardToViewport();
    requestAnimationFrame(() => {
      panelShellEl.classList.add('is-animating');
    });
  });

  panelTransitionTimer = window.setTimeout(() => {
    panels.forEach((panel) => {
      panel.classList.remove('panel-exiting');
      panel.classList.remove('panel-entering');
      if (panel !== activePanel) panel.hidden = true;
    });
    cardEl.classList.remove('swipe-back');
    panelShellEl.classList.remove('is-transitioning', 'is-animating');
    panelShellEl.style.height = 'auto';
    if (focusEl) focusEl.focus();
    fitCardToViewport();
  }, PANEL_TRANSITION_MS);
}

function showChoicePanel(direction = 'forward') {
  choiceResultEl.textContent = '';
  zoeVerifyBtn.disabled = true;
  transitionToPanel(methodChoiceEl, 'choice', choiceFaceBtn, direction);
}

function showZoeIdPanel(returnTarget = 'choice', direction = 'forward') {
  zoeIdReturnTarget = returnTarget;
  idResultEl.textContent = '';
  zoeVerifyBtn.disabled = true;
  transitionToPanel(zoeIdPanel, 'id', idUseBtn, direction);
}

function showVerificationPanel(direction = 'forward') {
  setEmergencyAssistAvailable(!pendingZoeIdRegistration);
  if (pendingZoeIdRegistration) {
    showCameraHelp('Zoe ID registration requires a face or hand check. In production, mobility/accessibility needs should go through manual review before passkey setup.');
  }
  zoeVerifyBtn.disabled = true;
  transitionToPanel(dialogEl, 'verify', startBtn, direction);
}

function showSuccessPanel() {
  zoeVerifyBtn.disabled = true;
  transitionToPanel(verifiedEl, 'success', resetBtn);
}

function showIntroPanel() {
  zoeIdReturnTarget = 'choice';
  setEmergencyAssistAvailable(true);
  zoeVerifyBtn.disabled = false;
  transitionToPanel(zoeIntroEl, null, zoeVerifyBtn, 'back');
}

function continueFromIntro() {
  if (isMobileLayout()) {
    selectPrimaryMethod('face');
    showVerificationPanel();
    autoStartVerification();
    return;
  }

  showChoicePanel();
}

function choosePrimaryMethod(method) {
  selectPrimaryMethod(method);
  showVerificationPanel();
  autoStartVerification();
}

function leaveZoeIdPanel() {
  if (zoeIdReturnTarget === 'verification') {
    showVerificationPanel('back');
    return;
  }

  showChoicePanel('back');
}

function showPrompt(step) {
  promptEmojiEl.textContent = step.emoji;
  promptNameEl.textContent = step.name;
  promptHintEl.textContent = step.hint;
}

function updateChecklistUI() {
  checkEls.forEach((el, i) => {
    el.classList.remove('active', 'done');
    el.hidden = selectedPrimaryMethod === 'face' || i >= totalSteps;
    if (selectedPrimaryMethod === 'face') return;
    const label = el.querySelector('.label');
    if (i < completedSteps) {
      el.classList.add('done');
      label.textContent = 'Verified';
    } else if (currentStep && i === currentStep.index) {
      el.classList.add('active');
      label.textContent = currentStep.name;
    } else {
      label.textContent = 'Locked';
    }
  });
}

function selectPrimaryMethod(method) {
  selectedPrimaryMethod = method;
  const isFace = method === 'face';
  methodHandBtn.classList.toggle('active', !isFace);
  methodFaceBtn.classList.toggle('active', isFace);
  methodHandBtn.setAttribute('aria-pressed', String(!isFace));
  methodFaceBtn.setAttribute('aria-pressed', String(isFace));

  verificationTitleEl.textContent = isFace ? 'Face verification' : 'Hand verification';
  promptEmojiEl.textContent = isFace ? '🙂' : '-';
  promptNameEl.textContent = isFace ? 'Turn gently left and right' : 'Click "Start" to begin';
  promptHintEl.textContent = isFace
    ? 'Keep your face in frame. Zoe checks motion, not identity.'
    : '';
  progressEl.style.width = '0%';
  updateChecklistUI();
  setStatus('Idle', 'idle');
}

function resetStepEvidence() {
  holdCounter = 0;
  waveHistory = [];
  waveMatched = false;
  framesSinceStep = 0;
  noHandFrames = 0;
  noMatchFrames = 0;
  landmarkSamples = [];
  motionSamples = [];
  stepStartedAt = performance.now();
  progressEl.style.width = '0%';
}

function failStep() {
  resetStepEvidence();
}

function quantize(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function sampleLandmarks(hands, detectedGesture) {
  if (landmarkSamples.length >= 24) return;
  const selected = [LM.wrist, LM.thumbTip, LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip];
  landmarkSamples.push({
    t: Math.round(performance.now() - stepStartedAt),
    g: detectedGesture,
    hands: hands.slice(0, 2).map((lm) =>
      selected.map((idx) => [quantize(lm[idx].x), quantize(lm[idx].y), quantize(lm[idx].z)])
    ),
  });
}

function sampleMotion(lm) {
  if (motionSamples.length >= 48) return;
  motionSamples.push({
    t: Math.round(performance.now() - stepStartedAt),
    x: quantize(lm[LM.wrist].x),
    y: quantize(lm[LM.wrist].y),
  });
}

async function digestString(value) {
  const input = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildEvidence() {
  const matchedAt = performance.now();
  const durationMs = Math.round(matchedAt - stepStartedAt);
  return {
    startedAt: Math.round(stepStartedAt),
    matchedAt: Math.round(matchedAt),
    durationMs,
    frameCount: framesSinceStep,
    holdFrames: holdCounter,
    landmarkDigest: await digestString(JSON.stringify(landmarkSamples)),
    motionDigest: await digestString(JSON.stringify(motionSamples)),
  };
}

async function submitCurrentStep() {
  if (submittingStep || !currentChallengeId || !currentStep) return;
  submittingStep = true;
  setStatus('Checking server...', 'cooldown');

  try {
    const evidence = await buildEvidence();
    const result = await apiJson('/api/step', {
      challengeId: currentChallengeId,
      stepIndex: currentStep.index,
      gestureId: currentStep.id,
      evidence,
    });

    completedSteps++;
    updateChecklistUI();

    if (result.verified) {
      verificationToken = result.verificationToken;
      await confirmProtectedAction();
      return;
    }

    currentStep = result.step;
    cooldownUntil = performance.now() + COOLDOWN_MS;
    setTimeout(() => {
      showPrompt(currentStep);
      resetStepEvidence();
      updateChecklistUI();
      setStatus('Listening...', 'listening');
      submittingStep = false;
    }, COOLDOWN_MS);
  } catch (err) {
    submittingStep = false;
    failStep();
    showError(err.message || 'Server rejected the step.');
  }
}

async function confirmProtectedAction() {
  try {
    if (pendingZoeIdRegistration) {
      const resultEl = pendingZoeIdResultEl || idResultEl;
      pendingZoeIdRegistration = false;
      pendingZoeIdResultEl = null;
      await createFreshPasskey(resultEl);
      stopDetection();
      stopCamera();
      showZoeIdPanel('choice', 'back');
      idResultEl.textContent = 'Zoe ID passkey saved. Next time, choose Use existing Zoe ID.';
      setAssistButtonsDisabled(false);
      return;
    }

    await apiJson('/api/protected-action', { verificationToken });
    stopDetection();
    stopCamera();
    showSuccessPanel();
    promptHintEl.textContent = '';
  } catch (err) {
    showError(err.message || 'Server rejected the verification token.');
  } finally {
    submittingStep = false;
  }
}

async function startVerification() {
  const challenge = await apiJson('/api/challenge');
  currentChallengeId = challenge.challengeId;
  currentStep = challenge.step;
  totalSteps = challenge.totalSteps;
  completedSteps = 0;
  verificationToken = null;
  cooldownUntil = 0;
  submittingStep = false;

  resetStepEvidence();
  hideCameraHelp();
  updateChecklistUI();
  showPrompt(currentStep);
  setStatus('Listening...', 'listening');
  setStartButton('Verification in progress', true);
}

function onResults(results) {
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (results.image) ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

  const hands = results.multiHandLandmarks || [];
  if (!hands.length) {
    if (currentStep && !cooldownUntil && !submittingStep) {
      noHandFrames++;
      setStatus('Show your hand', 'idle');
      if (noHandFrames > 75) {
        showCameraHelp('Try brighter light, move your whole hand into the box, and keep the camera steady.');
      }
    }
    return;
  }

  noHandFrames = 0;
  const lm = hands[0];
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    hands.forEach((hand) => {
      window.drawConnectors(ctx, hand, window.HAND_CONNECTIONS, { color: '#5b8cff', lineWidth: 3 });
      window.drawLandmarks(ctx, hand, { color: '#7b5bff', lineWidth: 1, radius: 4 });
    });
  }

  if (!currentStep || submittingStep) return;
  if (cooldownUntil && performance.now() < cooldownUntil) return;

  framesSinceStep++;
  sampleMotion(lm);

  let matched = false;
  let detectedGesture = null;
  if (currentStep.id === 'wave') {
    const openish =
      fingerExtended(lm, LM.indexTip, LM.indexPip) ||
      fingerExtended(lm, LM.middleTip, LM.middlePip);
    if (!waveMatched && openish && detectWave(lm)) waveMatched = true;
    matched = waveMatched;
    detectedGesture = matched ? 'wave' : null;
  } else if (currentStep.id === 'ily') {
    matched = detectTwoHandHeart(hands);
    detectedGesture = matched ? 'ily' : null;
  } else {
    detectedGesture = classifyGesture(lm);
    matched = detectedGesture === currentStep.id;
  }

  sampleLandmarks(hands, detectedGesture);

  if (matched) {
    noMatchFrames = 0;
    holdCounter++;
    progressEl.style.width = `${Math.min(100, (holdCounter / HOLD_FRAMES) * 100)}%`;
    if (holdCounter >= HOLD_FRAMES) {
      submitCurrentStep();
    } else {
      setStatus(`Hold it... ${holdCounter}/${HOLD_FRAMES}`, 'listening');
    }
  } else {
    noMatchFrames++;
    if (holdCounter > 0) failStep();
    if (noMatchFrames > 90) {
      const message = currentStep.id === 'ily'
        ? 'For hand hearts, use both hands: touch both thumbs together and both index fingertips together.'
        : 'If the pose is right but not landing, rotate your wrist slightly and move farther from the lens.';
      showCameraHelp(message);
    }
    setStatus('Try again', 'idle');
  }
}

async function startDetection() {
  if (detecting) return;
  detecting = true;
  const loop = async (ts) => {
    if (!detecting) return;
    if (ts - lastFrameTs >= FRAME_SAMPLE_MS) {
      lastFrameTs = ts;
      try {
        await handsModel.send({ image: videoEl });
      } catch {
        // Ignore individual frame errors; the UI still has timeout/error paths.
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopDetection() {
  detecting = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  videoEl.srcObject = null;
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
}

async function startHandVerificationFlow() {
  if (location.protocol === 'file:') {
    throw new Error('Run Zoe through the server with `npm start`; file:// cannot use server-bound verification.');
  }
  if (!handsModel) await initMediaPipe();
  if (!stream) await startCamera();
  if (!detecting) await startDetection();
  await startVerification();
}

async function startFaceVerificationFlow() {
  if (location.protocol === 'file:') {
    throw new Error('Run Zoe through the server with `npm start`; file:// cannot use server-bound verification.');
  }
  stopDetection();
  promptEmojiEl.textContent = '🙂';
  promptNameEl.textContent = 'Get ready';
  promptHintEl.textContent = 'Loading the face check…';
  setStatus('Starting camera...', 'listening');

  // Setup (camera + model load) is the part that can hang, so it stays under the
  // caller's init timeout. The interactive guided check then runs on its own.
  if (!stream) await startCamera();
  await ensureFaceEngine();

  runGuidedFaceCheck().catch((err) => {
    console.error(err);
    showError(err.message || 'Face check failed. Try again.');
  });
}

async function beginVerification() {
  if (verificationStarting || detecting || faceChecking) return;
  verificationStarting = true;
  setStartButton('Starting camera...', true);
  setStatus('Initializing...', 'listening');

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Camera or server init timed out.')), 15000)
  );

  try {
    if (selectedPrimaryMethod === 'hand' && !window.Hands) {
      throw new Error('MediaPipe Hands failed to load. Check your network and reload.');
    }
    const flow = selectedPrimaryMethod === 'face' ? startFaceVerificationFlow() : startHandVerificationFlow();
    await Promise.race([flow, timeout]);
  } catch (err) {
    console.error(err);
    showError(err.message || 'Could not start verification.');
  } finally {
    verificationStarting = false;
  }
}

// Auto-start once the verification stage is on screen. Called synchronously
// within the user gesture so camera permission prompts keep their activation.
function autoStartVerification() {
  if (dialogEl.hidden) return;
  beginVerification();
}

startBtn.addEventListener('click', beginVerification);

assistBtn.addEventListener('click', () => {
  const expanded = assistPanel.hidden;
  assistPanel.hidden = !expanded;
  assistBtn.setAttribute('aria-expanded', String(expanded));
  if (expanded) {
    assistResultEl.textContent = '';
    showCameraHelp('You can keep trying the camera check, or use the emergency check below.');
  }
});

function setAssistButtonsDisabled(disabled) {
  [choiceIdBtn, mobileIdBtn, idUseBtn, idRegisterBtn, idBackBtn, textChallengeBtn, audioChallengeBtn, audioRepeatBtn, fallbackSubmitBtn].forEach((button) => {
    button.disabled = disabled;
  });
}

function setEmergencyAssistAvailable(available) {
  assistBtn.hidden = !available;
  if (!available) {
    assistPanel.hidden = true;
    assistBtn.setAttribute('aria-expanded', 'false');
    fallbackForm.hidden = true;
    audioRepeatBtn.hidden = true;
    activeFallbackChallenge = null;
    assistResultEl.textContent = '';
  }
}

function passkeyUnavailableMessage() {
  if (!window.PublicKeyCredential) return 'This browser does not support passkeys here.';
  if (!window.isSecureContext) {
    return 'Passkeys require a secure origin. Open Zoe from http://localhost, http://127.0.0.1, or HTTPS.';
  }
  return '';
}

async function registerPasskey(registrationVerificationToken) {
  const unavailable = passkeyUnavailableMessage();
  if (unavailable) throw new Error(unavailable);

  const options = await apiJson('/api/passkey/register/options', { registrationVerificationToken });
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: base64urlToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: base64urlToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
        type: credential.type,
        id: base64urlToBuffer(credential.id),
      })),
    },
  });

  const publicKey = credential.response.getPublicKey && credential.response.getPublicKey();
  const alg = credential.response.getPublicKeyAlgorithm && credential.response.getPublicKeyAlgorithm();
  if (!publicKey || !alg) throw new Error('This browser did not expose passkey public-key details.');

  await apiJson('/api/passkey/register/verify', {
    rawId: bufferToBase64url(credential.rawId),
    clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
    publicKey: bufferToBase64url(publicKey),
    alg,
  });
}

async function authenticatePasskey() {
  const unavailable = passkeyUnavailableMessage();
  if (unavailable) throw new Error(unavailable);

  const options = await apiJson('/api/passkey/auth/options');
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: base64urlToBuffer(options.challenge),
      allowCredentials: options.allowCredentials.map((credential) => ({
        type: credential.type,
        id: base64urlToBuffer(credential.id),
      })),
      timeout: options.timeout,
      userVerification: options.userVerification,
    },
  });

  const result = await apiJson('/api/passkey/auth/verify', {
    rawId: bufferToBase64url(assertion.rawId),
    clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
    authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
    signature: bufferToBase64url(assertion.response.signature),
  });
  verificationToken = result.verificationToken;
  await confirmProtectedAction();
}

async function createFreshPasskey(resultEl = assistResultEl) {
  if (!verificationToken) {
    pendingZoeIdRegistration = true;
    pendingZoeIdResultEl = resultEl;
    resultEl.textContent = 'First complete a face or hand check. Then Zoe will save your passkey.';
    selectPrimaryMethod(isMobileLayout() ? 'face' : selectedPrimaryMethod);
    showVerificationPanel();
    autoStartVerification();
    return;
  }

  resultEl.textContent = 'Registering Zoe ID on this browser...';
  await registerPasskey(verificationToken);
  verificationToken = null;
  resultEl.textContent = 'Zoe ID passkey saved. Next time, choose Use existing Zoe ID.';
}

async function useZoeId(resultEl = assistResultEl) {
  const unavailable = passkeyUnavailableMessage();
  if (unavailable) {
    resultEl.textContent = unavailable;
    return;
  }

  setAssistButtonsDisabled(true);
  resultEl.textContent = 'Checking your Zoe ID...';
  try {
    await authenticatePasskey();
  } catch (err) {
    const message = String(err.message || '');
    resultEl.textContent = message.includes('No passkey')
      ? 'No Zoe ID passkey is registered in this session yet. Register Zoe ID below.'
      : `${err.message || 'Zoe ID check did not finish.'} If that passkey was deleted, register Zoe ID again.`;
    setAssistButtonsDisabled(false);
  }
}

async function beginFallback(mode) {
  const isAudioMode = mode === 'audio' || mode === 'emergency_audio';
  const isEmergencyMode = mode.startsWith('emergency_');
  if (isAudioMode && !window.speechSynthesis) {
    assistResultEl.textContent = 'This browser cannot speak the audio challenge.';
    return;
  }

  setAssistButtonsDisabled(true);
  fallbackForm.hidden = true;
  audioRepeatBtn.hidden = true;
  assistResultEl.textContent = isAudioMode
    ? 'Preparing the spoken emergency check...'
    : isEmergencyMode
      ? 'Preparing a one-use emergency check...'
      : 'Preparing the text check...';
  try {
    activeFallbackChallenge = await apiJson('/api/fallback/challenge', { mode });
    fallbackLabel.textContent = activeFallbackChallenge.prompt;
    fallbackAnswer.value = '';
    fallbackForm.hidden = false;
    audioRepeatBtn.hidden = !isAudioMode;
    fallbackAnswer.focus();
    assistResultEl.textContent = isAudioMode
      ? 'Emergency audio is temporary and lower assurance. I will say the digits twice.'
      : isEmergencyMode
        ? 'Emergency text is temporary and lower assurance.'
        : 'Type the words exactly as shown.';

    if (isAudioMode) {
      speakAudioChallenge(2);
    }
  } catch (err) {
    activeFallbackChallenge = null;
    assistResultEl.textContent = err.message || 'Could not start that check.';
  } finally {
    setAssistButtonsDisabled(false);
  }
}

textChallengeBtn.addEventListener('click', () => beginFallback('emergency_text'));
audioChallengeBtn.addEventListener('click', () => beginFallback('emergency_audio'));

function speakAudioChallenge(repeats = 1) {
  if (!activeFallbackChallenge || !activeFallbackChallenge.mode.includes('audio') || !activeFallbackChallenge.speakText) return;
  if (!window.speechSynthesis) return;

  window.speechSynthesis.cancel();
  for (let i = 0; i < repeats; i++) {
    const prefix = repeats > 1 && i === 1 ? 'Repeating. ' : '';
    const utterance = new SpeechSynthesisUtterance(`${prefix}${activeFallbackChallenge.speakText}`);
    utterance.rate = 0.62;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }
}

audioRepeatBtn.addEventListener('click', () => {
  assistResultEl.textContent = 'Repeating the digits slowly.';
  speakAudioChallenge(1);
});

fallbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeFallbackChallenge) return;
  setAssistButtonsDisabled(true);
  assistResultEl.textContent = 'Checking...';
  try {
    const result = await apiJson('/api/fallback/verify', {
      challengeId: activeFallbackChallenge.challengeId,
      answer: fallbackAnswer.value,
    });
    verificationToken = result.verificationToken;
    await confirmProtectedAction();
  } catch (err) {
    assistResultEl.textContent = err.message || 'That did not match.';
    setAssistButtonsDisabled(false);
  }
});

// Where the user's face should sit, normalized to [0,1] in the displayed
// camera frame: a centered, slightly upper oval.
const FACE_TARGET = { cx: 0.5, cy: 0.46, rx: 0.23, ry: 0.33 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FACE_BOX_GRACE_MS = 220;
const SHOW_FACE_DEBUG_BOX = false;
let recentFaceBox = null;
let recentFaceBoxAt = 0;

function sizeCanvasToDisplay(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}

function videoToCanvasTransform(canvasWidth, canvasHeight, fit = 'cover') {
  const videoWidth = Math.max(1, videoEl.videoWidth || 640);
  const videoHeight = Math.max(1, videoEl.videoHeight || 480);
  const scale = fit === 'cover'
    ? Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight)
    : Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  return {
    videoWidth,
    videoHeight,
    scale,
    dx: (canvasWidth - drawWidth) / 2,
    dy: (canvasHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

function mapVideoBoxToCanvas(box, transform) {
  return {
    x: transform.dx + box.x * transform.scale,
    y: transform.dy + box.y * transform.scale,
    w: box.w * transform.scale,
    h: box.h * transform.scale,
  };
}

// Pick the cross-browser MediaPipe Tasks Vision engine, falling back to the
// non-standard FaceDetector only when the MediaPipe runtime cannot load.
async function ensureFaceEngine() {
  if (faceModel) return 'mediapipe';
  if (legacyFaceDetector) return 'legacy';
  try {
    await initFaceDetection();
    return 'mediapipe';
  } catch (err) {
    console.error('MediaPipe face detector failed to load:', err);
    if ('FaceDetector' in window) {
      legacyFaceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      return 'legacy';
    }
    throw new Error('Face check could not start. Reload, or try Zoe ID or emergency text/audio.');
  }
}

// A real face box is roughly square and a sensible fraction of the frame. These
// guards reject false positives (e.g. a shoulder) that the detector occasionally
// reports with a bounding box that is too small, too large, or too elongated.
const FACE_MIN_SCORE = 0.5;
const FACE_MIN_W = 0.06;
const FACE_MAX_W = 0.85;
const FACE_MIN_ASPECT = 0.55; // width / height, in pixels
const FACE_MAX_ASPECT = 1.7;
// Only accept a face whose center sits inside (a slightly padded) target oval.
// Horizontal is generous so natural head turns still register. Vertical stays
// tight: a real face should be in the oval, not down on the shoulder line.
const FACE_OVAL_SCALE_X = 1.25;
const FACE_OVAL_SCALE_Y = 0.95;
const FACE_BOX_SHIFT_X = -0.75;
const FACE_BOX_SHIFT_Y = -0.55;
const FACE_BOX_HEIGHT_SCALE = 1.02;
// Face-box acceptance offsets are expressed as detected-box multipliers, not
// fixed pixels or fixed frame percentages, so they scale with camera distance.
const FACE_CENTER_GATE_X = 0.75;
const FACE_CENTER_GATE_Y = 0.75;
const FACE_MOTION_GATE_X = 0.45; // Legacy FaceDetector fallback only.
const YAW_CENTER_MAX = 0.25;
const YAW_TURN_MIN = 0.45;
const YAW_MOTION_RANGE_MIN = 0.35;

function plausibleFace(candidate, vw, vh) {
  const wNorm = candidate.w / vw;
  const aspect = candidate.w / Math.max(1, candidate.h);
  if (candidate.score < FACE_MIN_SCORE) return false;
  if (wNorm < FACE_MIN_W || wNorm > FACE_MAX_W) return false;
  if (aspect < FACE_MIN_ASPECT || aspect > FACE_MAX_ASPECT) return false;
  return true;
}

function detectionScore(detection) {
  const category = detection.categories && detection.categories[0];
  if (typeof category?.score === 'number') return category.score;
  if (typeof detection.score === 'number') return detection.score;
  return 0;
}

function detectionBox(detection, vw, vh) {
  const b = detection.boundingBox || detection.bounding_box || {};
  let x = b.originX ?? b.x ?? b.xMin ?? b.left ?? 0;
  let y = b.originY ?? b.y ?? b.yMin ?? b.top ?? 0;
  let w = b.width ?? ((b.xMax ?? b.right ?? 0) - x);
  let h = b.height ?? ((b.yMax ?? b.bottom ?? 0) - y);
  // Tasks Vision bounding boxes are pixel-space. This keeps the helper tolerant
  // if a browser/runtime ever returns normalized values.
  if (w <= 1 && h <= 1 && x <= 1 && y <= 1) {
    x *= vw;
    y *= vh;
    w *= vw;
    h *= vh;
  }
  return { x, y, w, h };
}

function calibratedFaceBox(box, vw, vh) {
  // In this camera/model setup Blaze's raw box tracks the face pattern but is
  // consistently displaced down/right on the displayed frame. Keep all detector
  // calibration centralized here so drawing and motion checks share one box.
  const w = box.w;
  const h = box.h * FACE_BOX_HEIGHT_SCALE;
  const x = box.x + box.w * FACE_BOX_SHIFT_X;
  const y = box.y + box.h * FACE_BOX_SHIFT_Y;
  return {
    x: Math.min(Math.max(0, x), Math.max(0, vw - w)),
    y: Math.min(Math.max(0, y), Math.max(0, vh - h)),
    w,
    h,
  };
}

function pointToPixel(point, vw, vh) {
  return {
    x: point.x <= 1 ? point.x * vw : point.x,
    y: point.y <= 1 ? point.y * vh : point.y,
  };
}

function poseFromKeypoints(keypoints, vw, vh) {
  if (!keypoints || keypoints.length < 3) return null;
  // MediaPipe FaceDetector keypoints are eyes, nose, mouth, and ear tragions.
  // Ratios are based on eye distance so pose remains scale-independent.
  const points = keypoints.map((point) => pointToPixel(point, vw, vh));
  const eyeA = points[0];
  const eyeB = points[1];
  const nose = points[2];
  const eyeDx = eyeB.x - eyeA.x;
  const eyeDy = eyeB.y - eyeA.y;
  const eyeDistance = Math.hypot(eyeDx, eyeDy);
  if (!Number.isFinite(eyeDistance) || eyeDistance < 1) return null;
  const eyeCenter = {
    x: (eyeA.x + eyeB.x) / 2,
    y: (eyeA.y + eyeB.y) / 2,
  };
  const yaw = (nose.x - eyeCenter.x) / eyeDistance;
  const pose = Math.abs(yaw) <= YAW_CENTER_MAX
    ? 'center'
    : yaw <= -YAW_TURN_MIN
      ? 'right'
      : yaw >= YAW_TURN_MIN
        ? 'left'
        : yaw < 0
          ? 'lean-right'
          : 'lean-left';
  return { yaw, pose };
}

// True when the box center lies within the target oval. The oval is symmetric
// about cx=0.5, so the same distance test works in raw and displayed coords.
function centerInTargetOval(box) {
  const nx = (box.cx - FACE_TARGET.cx) / (FACE_TARGET.rx * FACE_OVAL_SCALE_X);
  const ny = (box.cy - FACE_TARGET.cy) / (FACE_TARGET.ry * FACE_OVAL_SCALE_Y);
  return nx * nx + ny * ny <= 1;
}

function displayedFaceX(box) {
  // Single conversion point between detector and display coordinates. The app
  // deliberately starts unmirrored, so detector x maps directly to display x.
  return box.cx;
}

// Returns the best detected face box normalized to [0,1] as { cx, cy, w, h, score }
// in the same video-frame coordinates used by the overlay, or null when no
// plausible face is found.
async function detectFaceFrame(engine) {
  const vw = Math.max(1, videoEl.videoWidth || 640);
  const vh = Math.max(1, videoEl.videoHeight || 480);
  let candidates = [];
  if (engine === 'mediapipe') {
    let result = null;
    try {
      result = faceModel.detectForVideo(videoEl, performance.now());
    } catch {
      // Ignore transient per-frame errors.
    }
    const detections = (result && result.detections) || [];
    candidates = detections
      .map((detection) => {
        const rawBox = detectionBox(detection, vw, vh);
        const box = calibratedFaceBox(rawBox, vw, vh);
        const pose = poseFromKeypoints(detection.keypoints, vw, vh);
        return {
          ...box,
          score: detectionScore(detection),
          detection,
          rawBox,
          pose,
        };
      });
  } else {
    const faces = await legacyFaceDetector.detect(videoEl).catch(() => []);
    candidates = faces.map((f) => ({
      x: f.boundingBox.x,
      y: f.boundingBox.y,
      w: f.boundingBox.width,
      h: f.boundingBox.height,
      score: 1,
    }));
  }

  let best = null;
  for (const c of candidates) {
    if (!plausibleFace(c, vw, vh)) continue;
    const box = {
      cx: (c.x + c.w / 2) / vw,
      cy: (c.y + c.h / 2) / vh,
      w: c.w / vw,
      h: c.h / vh,
      pixelBox: { x: c.x, y: c.y, w: c.w, h: c.h },
      pose: c.pose || null,
      // Confidence first, then area. This favors real close-up faces while the
      // oval and size/aspect gates reject obvious non-face regions.
      score: c.score * (c.w / vw) * (c.h / vh),
    };
    // Prefer faces whose center is close to the target oval center.
    // A well-centered real face beats a larger off-center shoulder.
    const dx = (box.cx - FACE_TARGET.cx) / FACE_TARGET.rx;
    const dy = (box.cy - FACE_TARGET.cy) / FACE_TARGET.ry;
    const centerDist = Math.sqrt(dx * dx + dy * dy);
    box.score *= Math.max(0.3, 1.8 - centerDist);
    // Reject anything whose center is outside the on-screen oval (e.g. a shoulder
    // sitting below the frame's face zone).
    if (!centerInTargetOval(box)) continue;
    if (!best || box.score > best.score) best = box;
  }
  return best;
}

async function detectStableFaceFrame(engine) {
  const box = await detectFaceFrame(engine);
  if (box) {
    recentFaceBox = box;
    recentFaceBoxAt = performance.now();
    return box;
  }
  if (recentFaceBox && performance.now() - recentFaceBoxAt <= FACE_BOX_GRACE_MS) {
    return { ...recentFaceBox, stale: true };
  }
  return null;
}

function drawGuideArrow(direction, color) {
  const W = canvasEl.width;
  const H = canvasEl.height;
  const cy = FACE_TARGET.cy * H;
  const size = Math.min(W, H) * 0.08;
  const x = direction === 'left' ? W * 0.1 : W * 0.9;
  const dir = direction === 'left' ? -1 : 1;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + dir * size * 0.5, cy - size);
  ctx.lineTo(x - dir * size * 0.5, cy);
  ctx.lineTo(x + dir * size * 0.5, cy + size);
  ctx.stroke();
  ctx.restore();
}

// Renders the camera feed, the target oval, the live face box, and an optional
// directional arrow. `box` uses the same video-frame coordinates as the overlay.
function drawFaceGuide(box, opts = {}) {
  const { width: W, height: H } = sizeCanvasToDisplay(canvasEl);
  const transform = videoToCanvasTransform(W, H, 'cover');
  const state = opts.state || 'neutral';
  const color = state === 'good' ? '#36c275' : state === 'move' ? '#ffce4d' : 'rgba(255,255,255,0.85)';

  ctx.clearRect(0, 0, W, H);

  ctx.drawImage(videoEl, transform.dx, transform.dy, transform.drawWidth, transform.drawHeight);

  // Spotlight: dim everything except the face-center oval. The even-odd fill
  // paints the region outside the ellipse, leaving the oval interior bright.
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,18,0.6)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.ellipse(FACE_TARGET.cx * W, FACE_TARGET.cy * H, FACE_TARGET.rx * W, FACE_TARGET.ry * H, 0, 0, Math.PI * 2);
  ctx.fill('evenodd');
  ctx.restore();

  // Target oval where the face should sit.
  ctx.save();
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.ellipse(FACE_TARGET.cx * W, FACE_TARGET.cy * H, FACE_TARGET.rx * W, FACE_TARGET.ry * H, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Live face box in the same unmirrored coordinate space as the camera frame.
  if (SHOW_FACE_DEBUG_BOX && box) {
    const mappedBox = mapVideoBoxToCanvas(box.pixelBox, transform);
    ctx.save();
    ctx.strokeStyle = 'rgba(91,140,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mappedBox.x, mappedBox.y, mappedBox.w, mappedBox.h);
    ctx.restore();
  }

  if (opts.arrow === 'left' || opts.arrow === 'right') drawGuideArrow(opts.arrow, color);
}

// One guided motion phase: prompt the user and wait until keypoint geometry
// shows the requested head pose. Records sampled box/yaw evidence.
async function runFaceMotionPhase(engine, centers, sizes, yaws, poses, opts) {
  setStatus(opts.label, 'listening');
  promptNameEl.textContent = opts.label;
  promptHintEl.textContent = opts.hint;
  let hits = 0;
  while (faceChecking && performance.now() < opts.deadline) {
    const box = await detectStableFaceFrame(engine);
    if (box) {
      if (!box.stale) {
        centers.push(box.cx);
        sizes.push(box.w);
        if (box.pose) {
          yaws.push(box.pose.yaw);
          poses.push(box.pose.pose);
        }
      }
      promptHintEl.textContent = opts.hint;
      drawFaceGuide(box, { state: 'move', arrow: opts.arrow });
      const displayed = displayedFaceX(box);
      if (!box.stale && opts.reached(box.pose, box, displayed)) {
        hits++;
        if (hits >= 2) return true;
      } else {
        hits = 0;
      }
    } else {
      promptHintEl.textContent = 'Keep your face in view';
      drawFaceGuide(null, { state: 'move', arrow: opts.arrow });
      hits = 0;
    }
    await sleep(55);
  }
  return false;
}

async function runGuidedFaceCheck() {
  const engine = await ensureFaceEngine();
  const requirePoseLiveness = engine === 'mediapipe';
  faceChecking = true;
  setStartButton('Verification in progress', true);
  promptEmojiEl.textContent = '🙂';
  progressEl.style.width = '0%';

  const centers = [];
  const sizes = [];
  const yaws = [];
  const poses = [];
  const startedAt = performance.now();
  const deadline = startedAt + 30000;
  recentFaceBox = null;
  recentFaceBoxAt = 0;

  try {
    const inTarget = (box) => {
      if (!box) return false;
      const dx = Math.abs(displayedFaceX(box) - FACE_TARGET.cx);
      const dy = Math.abs(box.cy - FACE_TARGET.cy);
      const sizeOk = box.w > 0.12 && box.w < 0.7;
      const poseOk = !requirePoseLiveness || (box.pose && box.pose.pose === 'center');
      return dx < box.w * FACE_CENTER_GATE_X && dy < box.h * FACE_CENTER_GATE_Y && sizeOk && poseOk;
    };

    // Phase 1: center the face inside the oval.
    setStatus('Center your face', 'listening');
    promptNameEl.textContent = 'Center your face';
    promptHintEl.textContent = 'Fit your face inside the oval and hold still.';
    let centeredFrames = 0;
    while (faceChecking && performance.now() < deadline) {
      const box = await detectStableFaceFrame(engine);
      if (box && !box.stale) {
        centers.push(box.cx);
        sizes.push(box.w);
        if (box.pose) {
          yaws.push(box.pose.yaw);
          poses.push(box.pose.pose);
        }
      }
      const ok = inTarget(box);
      promptHintEl.textContent = !box
        ? 'Show your face'
        : ok
          ? 'Great — hold still'
          : box.pose && box.pose.pose !== 'center'
            ? 'Face forward, then hold still'
            : 'Fit your face inside the oval';
      drawFaceGuide(box, { state: ok ? 'good' : 'neutral', arrow: null });
      if (ok) {
        centeredFrames++;
        if (centeredFrames >= 6) break;
      } else {
        centeredFrames = 0;
      }
      await sleep(55);
    }
    if (centeredFrames < 6) {
      throw new Error('Face was not centered in the oval. Center your face and try again.');
    }
    progressEl.style.width = '33%';

    // Phase 2: turn left (keypoint geometry must show a left-facing pose).
    const movedLeft = await runFaceMotionPhase(engine, centers, sizes, yaws, poses, {
      label: 'Turn left',
      hint: 'Slowly turn your head to the left.',
      arrow: 'left',
      deadline,
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'left'
        : displayed <= FACE_TARGET.cx - box.w * FACE_MOTION_GATE_X,
    });
    if (!movedLeft) {
      throw new Error('Face motion timed out. Turn your head left when prompted, then try again.');
    }
    progressEl.style.width = '66%';

    // Phase 3: turn right (keypoint geometry must show a right-facing pose).
    const movedRight = await runFaceMotionPhase(engine, centers, sizes, yaws, poses, {
      label: 'Turn right',
      hint: 'Now slowly turn your head to the right.',
      arrow: 'right',
      deadline,
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'right'
        : displayed >= FACE_TARGET.cx + box.w * FACE_MOTION_GATE_X,
    });
    if (!movedRight) {
      throw new Error('Face motion timed out. Turn your head right when prompted, then try again.');
    }
    progressEl.style.width = '100%';

    if (!faceChecking) return;

    if (centers.length < 8 || (requirePoseLiveness && yaws.length < 8)) {
      throw new Error('No face was detected. Make sure your face is lit and centered, then try again.');
    }
    const yawRange = yaws.length ? Math.max(...yaws) - Math.min(...yaws) : 0;
    const poseSequenceOk = poses.includes('center') && poses.includes('left') && poses.includes('right');
    if (requirePoseLiveness && (!poseSequenceOk || yawRange < YAW_MOTION_RANGE_MIN)) {
      throw new Error('Head turn motion was too small. Face forward, then turn left and right when prompted.');
    }

    setStatus('Checking…', 'listening');
    promptNameEl.textContent = 'Checking…';
    promptHintEl.textContent = 'Confirming your liveness check.';
    drawFaceGuide(null, { state: 'good' });

    const durationMs = Math.min(15000, Math.max(900, Math.round(performance.now() - startedAt)));
    const centerMotion = Math.max(...centers) - Math.min(...centers);
    const sizeMotion = Math.max(...sizes) - Math.min(...sizes);
    const result = await apiJson('/api/liveness/verify', {
      durationMs,
      faceFrames: centers.length,
      motionScore: Math.max(yawRange, centerMotion, sizeMotion),
    });
    verificationToken = result.verificationToken;
    await confirmProtectedAction();
  } finally {
    faceChecking = false;
    recentFaceBox = null;
    recentFaceBoxAt = 0;
  }
}

resetBtn.addEventListener('click', () => {
  faceChecking = false;
  stopDetection();
  stopCamera();
  currentChallengeId = null;
  currentStep = null;
  completedSteps = 0;
  verificationToken = null;
  cooldownUntil = 0;
  submittingStep = false;
  resetStepEvidence();
  hideCameraHelp();
  assistPanel.hidden = true;
  assistBtn.setAttribute('aria-expanded', 'false');
  setAssistButtonsDisabled(false);
  fallbackForm.hidden = true;
  audioRepeatBtn.hidden = true;
  activeFallbackChallenge = null;
  assistResultEl.textContent = '';
  choiceResultEl.textContent = '';
  idResultEl.textContent = '';

  showIntroPanel();

  setStartButton('Start check', false);
  checkEls.forEach((el) => {
    el.classList.remove('active', 'done');
    el.hidden = selectedPrimaryMethod === 'face';
    el.querySelector('.label').textContent = '-';
  });
  selectPrimaryMethod(selectedPrimaryMethod);
  setStatus('Idle', 'idle');
});

methodHandBtn.addEventListener('click', () => selectPrimaryMethod('hand'));
methodFaceBtn.addEventListener('click', () => selectPrimaryMethod('face'));
choiceFaceBtn.addEventListener('click', () => choosePrimaryMethod('face'));
choiceHandBtn.addEventListener('click', () => choosePrimaryMethod('hand'));
choiceIdBtn.addEventListener('click', () => showZoeIdPanel('choice'));
idUseBtn.addEventListener('click', () => useZoeId(idResultEl));
idRegisterBtn.addEventListener('click', async () => {
  const unavailable = passkeyUnavailableMessage();
  if (unavailable) {
    idResultEl.textContent = unavailable;
    return;
  }

  setAssistButtonsDisabled(true);
  try {
    await createFreshPasskey(idResultEl);
    if (!pendingZoeIdRegistration) setAssistButtonsDisabled(false);
  } catch (err) {
    idResultEl.textContent = err.message || 'Could not register Zoe ID.';
    setAssistButtonsDisabled(false);
  }
});
idBackBtn.addEventListener('click', leaveZoeIdPanel);
mobileIdBtn.addEventListener('click', () => showZoeIdPanel('verification'));
zoeVerifyBtn.addEventListener('click', continueFromIntro);
selectPrimaryMethod(isMobileLayout() ? 'face' : 'hand');

// Keep the whole card centered and fully in frame on any screen: scale it down
// to fit the viewport whenever it would otherwise overflow (width or height).
function fitCardToViewport() {
  if (!cardEl) return;
  const margin = 16;
  const availW = window.innerWidth - margin * 2;
  const availH = window.innerHeight - margin * 2;
  const w = cardEl.offsetWidth;
  const h = cardEl.offsetHeight;
  if (!w || !h) return;
  const scale = Math.min(1, availW / w, availH / h);
  cardEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener('resize', fitCardToViewport);
window.addEventListener('orientationchange', fitCardToViewport);
// Recompute when the card's own size changes (panel switches, camera turning on).
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fitCardToViewport).observe(cardEl);
}
fitCardToViewport();
