// Zoe - human-presence verification.
// The browser performs local hand-pose detection, but the server owns
// challenge order, replay state, and the final verification token.

const HOLD_FRAMES = 8;
const COOLDOWN_MS = 1200;
const FRAME_SAMPLE_MS = 33;
const HOLD_MISMATCH_GRACE_FRAMES = 3;
const HAND_POSE_CHANGE_MIN = 0.08;

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
let formingSamples = [];
let holdMotionSamples = [];
let gestureMatchedAt = 0;
let verificationToken = null;
let noHandFrames = 0;
let noMatchFrames = 0;
let holdMismatchFrames = 0;
let currentHandShape = null;
let lastAcceptedHandShape = null;
let awaitingHandPoseChange = false;
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
const cardEl = $('captcha-card');
const flashOverlayEl = $('flash-overlay');
const flashConsentEl = $('flash-consent');
const flashConsentAcceptBtn = $('flash-consent-accept');
const flashConsentDeclineBtn = $('flash-consent-decline');
const flowStepsEl = $('flow-steps');
const flowStepLabelEl = $('flow-step-label');
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
const cameraHelpEl = $('camera-help');
const cameraHelpTextEl = $('camera-help-text');
const bootLoaderEl = $('boot-loader');
const checkEls = Array.from(document.querySelectorAll('.check'));

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
  if (okDist < 0.06 && [middle, ring, pinky].filter(Boolean).length >= 2) return 'ok';
  if (!thumb && index && !middle && !ring && pinky) return 'rock';
  if (!thumb && index && middle && ring && !pinky) return 'three';
  if (thumb && !index && !middle && !ring && pinky) return 'call_me';
  if (index && middle && !ring && !pinky) return 'peace';
  if (index && !middle && !ring && !pinky) return 'point';
  const compactFist = [
    [LM.indexTip, LM.indexPip],
    [LM.middleTip, LM.middlePip],
    [LM.ringTip, LM.ringPip],
    [LM.pinkyTip, LM.pinkyPip],
  ].every(([tip, pip]) => dist(lm[tip], lm[LM.wrist]) < dist(lm[pip], lm[LM.wrist]) * 1.12);
  if (!index && !middle && !ring && !pinky && !thumb && compactFist) return 'fist';
  return null;
}

function normalizedHandShape(lm) {
  const wrist = lm[LM.wrist];
  const scale = Math.max(0.01, dist(wrist, lm[LM.middleMcp]));
  return lm.map((point) => ({
    x: (point.x - wrist.x) / scale,
    y: (point.y - wrist.y) / scale,
    z: ((point.z || 0) - (wrist.z || 0)) / scale,
  }));
}

function handShapeDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  return a.reduce((sum, point, index) => sum + dist(point, b[index]), 0) / a.length;
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
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function askForFlashFallback() {
  return new Promise((resolve) => {
    const finish = (accepted) => {
      flashConsentEl.hidden = true;
      flashConsentAcceptBtn.removeEventListener('click', accept);
      flashConsentDeclineBtn.removeEventListener('click', decline);
      resolve(accepted);
    };
    const accept = () => finish(true);
    const decline = () => finish(false);
    flashConsentAcceptBtn.addEventListener('click', accept);
    flashConsentDeclineBtn.addEventListener('click', decline);
    flashConsentEl.hidden = false;
    flashConsentDeclineBtn.focus();
  });
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
    setZoeIdButtonsDisabled(false);
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
let successSettleTimer = null;

const FLOW_STEP_INDEX = { choice: 2, id: 2, verify: 3, success: 4 };

function setFlowStep(mode) {
  const n = FLOW_STEP_INDEX[mode] || 1;
  if (flowStepLabelEl) flowStepLabelEl.textContent = `Step ${n} of 4`;
  if (!flowStepsEl) return;
  flowStepsEl.querySelectorAll('.step').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === n);
    el.classList.toggle('done', i + 1 < n);
  });
}

function setCardMode(mode) {
  cardEl.classList.toggle('choice-mode', mode === 'choice');
  cardEl.classList.toggle('id-mode', mode === 'id');
  cardEl.classList.toggle('verify-mode', mode === 'verify');
  cardEl.classList.toggle('success-mode', mode === 'success');
  setFlowStep(mode);
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
  if (pendingZoeIdRegistration) {
    showCameraHelp('Zoe ID registration requires a face or hand check first.');
  }
  zoeVerifyBtn.disabled = true;
  transitionToPanel(dialogEl, 'verify', startBtn, direction);
}

function showSuccessPanel() {
  zoeVerifyBtn.disabled = true;
  if (successSettleTimer) window.clearTimeout(successSettleTimer);
  verifiedEl.classList.remove('settled');
  transitionToPanel(verifiedEl, 'success', null);
  successSettleTimer = window.setTimeout(() => {
    if (!verifiedEl.hidden) verifiedEl.classList.add('settled');
  }, prefersReducedMotion() ? 0 : 850);
}

function showIntroPanel() {
  zoeIdReturnTarget = 'choice';
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
  holdMismatchFrames = 0;
  landmarkSamples = [];
  motionSamples = [];
  formingSamples = [];
  holdMotionSamples = [];
  gestureMatchedAt = 0;
  stepStartedAt = performance.now();
  progressEl.style.width = '0%';
}

function failStep() {
  resetStepEvidence();
}

function quantize(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function motionScalar(sample) {
  if (sample && Number.isFinite(sample.v)) return sample.v;
  if (sample && Number.isFinite(sample.x)) return sample.x;
  return 0;
}

function computeMotionFeatures(samples) {
  if (!samples || samples.length < 2) {
    return { holdJitterRms: 0, tortuosity: 1, transitionMs: 0, sampleCount: samples?.length || 0 };
  }
  const values = samples.map(motionScalar);
  const times = samples.map((sample) => Number(sample.t));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const holdJitterRms = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  );

  let pathLength = 0;
  for (let i = 1; i < values.length; i++) {
    pathLength += Math.abs(values[i] - values[i - 1]);
  }
  const chord = Math.abs(values[values.length - 1] - values[0]);
  const tortuosity = pathLength / Math.max(chord, 1e-9);

  return {
    holdJitterRms,
    tortuosity,
    transitionMs: times[times.length - 1] - times[0],
    sampleCount: samples.length,
  };
}

function planarVariance(samples) {
  if (!samples || samples.length < 3) return 0;
  const xs = samples.map((sample) => Number(sample.x));
  const ys = samples.map((sample) => Number(sample.y));
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  return xs.reduce((sum, x, index) => sum + (x - meanX) ** 2 + (ys[index] - meanY) ** 2, 0) / xs.length;
}

const LIVENESS_HOLD_JITTER_MIN = 0.00035;
const LIVENESS_TRANSITION_JITTER_MIN = 0.00035;
const LIVENESS_TORTUOSITY_MIN = 1.004;
const LIVENESS_SYNTHETIC_JITTER_MAX = 0.00015;
const LIVENESS_SYNTHETIC_TORTUOSITY_MAX = 1.003;
const LIVENESS_TRANSITION_MS_MIN = 150;
const LIVENESS_TRANSITION_MS_MAX = 14 * 1000;
const HAND_MOTION_FORMING_MIN = 1e-8;
const HAND_MOTION_HOLD_JITTER_MIN = 1e-6;

function isSyntheticLivenessPhase(phase) {
  return (
    phase.holdJitterRms <= LIVENESS_SYNTHETIC_JITTER_MAX
    && phase.tortuosity >= 1
    && phase.tortuosity <= LIVENESS_SYNTHETIC_TORTUOSITY_MAX
  );
}

function evaluateFaceMotionLiveness(phases, { legacy = false } = {}) {
  const holdJitterMin = legacy ? LIVENESS_HOLD_JITTER_MIN * 0.5 : LIVENESS_HOLD_JITTER_MIN;
  const transitionJitterMin = legacy ? LIVENESS_TRANSITION_JITTER_MIN * 0.5 : LIVENESS_TRANSITION_JITTER_MIN;
  const tortuosityMin = legacy ? 1.002 : LIVENESS_TORTUOSITY_MIN;

  const hasIrregularity = phases.some(
    (phase) => phase.holdJitterRms >= holdJitterMin || phase.tortuosity >= tortuosityMin
  );
  if (!hasIrregularity) {
    return 'Face motion looked too uniform. Hold still in the oval, then turn gently left and right.';
  }

  const allSynthetic = phases.every((phase) => isSyntheticLivenessPhase(phase));
  if (allSynthetic) {
    return 'Face motion looked synthetic. Turn your head naturally when prompted.';
  }

  const transitions = phases.filter((phase) => phase.id !== 'center_hold');
  for (const phase of transitions) {
    if (phase.transitionMs < LIVENESS_TRANSITION_MS_MIN || phase.transitionMs > LIVENESS_TRANSITION_MS_MAX) {
      return 'Head turns were too fast or too slow. Turn gently when prompted.';
    }
    if (phase.holdJitterRms < transitionJitterMin && phase.tortuosity < tortuosityMin) {
      return 'Between-pose motion was too smooth. Turn your head in one continuous motion.';
    }
  }

  return null;
}

function summarizeLivenessPhase(id, samples) {
  const features = computeMotionFeatures(samples);
  return { id, ...features };
}

function handMotionLooksSynthetic(stats) {
  if (!stats) return false;
  return stats.holdJitterRms < HAND_MOTION_HOLD_JITTER_MIN && stats.formingMotion < HAND_MOTION_FORMING_MIN;
}

// Packed order must match server.js hand evidence indices for geometry checks.
const HAND_EVIDENCE_LM = [
  LM.wrist, LM.thumbCmc, LM.indexMcp, LM.thumbTip,
  LM.indexPip, LM.indexTip, LM.middlePip, LM.middleTip,
  LM.ringPip, LM.ringTip, LM.pinkyPip, LM.pinkyTip,
];

function sampleLandmarks(hands, detectedGesture) {
  if (landmarkSamples.length >= 24) return;
  landmarkSamples.push({
    t: Math.round(performance.now() - stepStartedAt),
    g: detectedGesture,
    hands: hands.slice(0, 2).map((lm) =>
      HAND_EVIDENCE_LM.map((idx) => [quantize(lm[idx].x), quantize(lm[idx].y), quantize(lm[idx].z)])
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

async function livenessSeriesDigest(challengeId, motionSeries) {
  return digestString(`${challengeId}\n${JSON.stringify(motionSeries)}`);
}

async function buildEvidence() {
  const matchedAt = performance.now();
  const durationMs = Math.round(matchedAt - stepStartedAt);
  const holdSamples = holdMotionSamples.length
    ? holdMotionSamples
    : motionSamples.filter((sample) => sample.t >= Math.round(gestureMatchedAt - stepStartedAt));
  const holdFeatures = computeMotionFeatures(holdSamples.map((sample) => ({ t: sample.t, v: sample.x })));
  const formingMotion = planarVariance(formingSamples);
  const motionStats = {
    holdJitterRms: holdFeatures.holdJitterRms,
    formingMotion,
  };
  if (currentStep?.id === 'wave' && motionSamples.length >= 4) {
    motionStats.tortuosity = computeMotionFeatures(
      motionSamples.map((sample) => ({ t: sample.t, v: sample.x }))
    ).tortuosity;
  }
  return {
    startedAt: Math.round(stepStartedAt),
    matchedAt: Math.round(matchedAt),
    durationMs,
    frameCount: framesSinceStep,
    holdFrames: holdCounter,
    landmarkDigest: await digestString(JSON.stringify(landmarkSamples)),
    landmarkSamples: landmarkSamples.slice(0, 24),
    motionDigest: await digestString(JSON.stringify(motionSamples)),
    motionStats,
  };
}

async function submitCurrentStep() {
  if (submittingStep || !currentChallengeId || !currentStep) return;
  submittingStep = true;
  const acceptedHandShape = currentHandShape;
  setStatus('Checking server...', 'cooldown');

  try {
    const evidence = await buildEvidence();
    if (handMotionLooksSynthetic(evidence.motionStats)) {
      throw new Error('Hand motion looked too static. Relax your wrist and try the gesture again.');
    }
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
    lastAcceptedHandShape = acceptedHandShape;
    awaitingHandPoseChange = Boolean(lastAcceptedHandShape);
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
      setZoeIdButtonsDisabled(false);
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
  currentHandShape = null;
  lastAcceptedHandShape = null;
  awaitingHandPoseChange = false;

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
  currentHandShape = normalizedHandShape(lm);

  if (awaitingHandPoseChange) {
    if (handShapeDistance(currentHandShape, lastAcceptedHandShape) < HAND_POSE_CHANGE_MIN) {
      setStatus('Change to the new pose', 'idle');
      return;
    }
    awaitingHandPoseChange = false;
  }

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

  if (!matched) {
    if (formingSamples.length < 48) {
      formingSamples.push({
        t: Math.round(performance.now() - stepStartedAt),
        x: quantize(lm[LM.wrist].x),
        y: quantize(lm[LM.wrist].y),
      });
    }
  } else if (gestureMatchedAt === 0) {
    gestureMatchedAt = performance.now();
  }

  sampleLandmarks(hands, detectedGesture);

  if (matched) {
    if (holdMotionSamples.length < 48) {
      holdMotionSamples.push({
        t: Math.round(performance.now() - stepStartedAt),
        x: quantize(lm[LM.wrist].x),
        y: quantize(lm[LM.wrist].y),
      });
    }
    noMatchFrames = 0;
    holdMismatchFrames = 0;
    holdCounter++;
    progressEl.style.width = `${Math.min(100, (holdCounter / HOLD_FRAMES) * 100)}%`;
    if (holdCounter >= HOLD_FRAMES) {
      submitCurrentStep();
    } else {
      setStatus(`Hold it... ${holdCounter}/${HOLD_FRAMES}`, 'listening');
    }
  } else {
    noMatchFrames++;
    if (holdCounter > 0) {
      holdMismatchFrames++;
      if (holdMismatchFrames <= HOLD_MISMATCH_GRACE_FRAMES) {
        setStatus(`Hold it... ${holdCounter}/${HOLD_FRAMES}`, 'listening');
        return;
      }
      failStep();
    }
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

function setZoeIdButtonsDisabled(disabled) {
  [choiceIdBtn, mobileIdBtn, idUseBtn, idRegisterBtn, idBackBtn].forEach((button) => {
    button.disabled = disabled;
  });
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
    attestationObject: credential.response.attestationObject
      ? bufferToBase64url(credential.response.attestationObject)
      : undefined,
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

async function createFreshPasskey(resultEl = idResultEl) {
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

async function useZoeId(resultEl = idResultEl) {
  const unavailable = passkeyUnavailableMessage();
  if (unavailable) {
    resultEl.textContent = unavailable;
    return;
  }

  setZoeIdButtonsDisabled(true);
  resultEl.textContent = 'Checking your Zoe ID...';
  try {
    await authenticatePasskey();
  } catch (err) {
    const message = String(err.message || '');
    resultEl.textContent = message.includes('No passkey')
      ? 'No Zoe ID passkey is registered in this session yet. Register Zoe ID below.'
      : `${err.message || 'Zoe ID check did not finish.'} If that passkey was deleted, register Zoe ID again.`;
    setZoeIdButtonsDisabled(false);
  }
}

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
    throw new Error('Face check could not start. Reload, or try Zoe ID.');
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
      keypoints: c.detection?.keypoints || null,
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

function quantizedFaceShapeExtras(keypoints) {
  if (!keypoints || keypoints.length < 6) return {};
  const mouth = keypoints[3];
  const earA = keypoints[4];
  const earB = keypoints[5];
  const nose = keypoints[2];
  if (!mouth || !earA || !earB || !nose) return {};
  const mouthW = Math.hypot(mouth.x - nose.x, mouth.y - nose.y);
  const earSpan = Math.hypot(earA.x - earB.x, earA.y - earB.y);
  return { m: quantize(mouthW), e: quantize(earSpan) };
}

function pushFaceSeriesSample(phaseSeries, phase, flowStartedAt, motionValue, keypoints) {
  if (phaseSeries.length >= 120) return;
  const sample = {
    phase,
    t: Math.round(performance.now() - flowStartedAt),
    v: quantize(motionValue),
  };
  Object.assign(sample, quantizedFaceShapeExtras(keypoints));
  phaseSeries.push(sample);
}

function faceMotionPhaseConfig(phaseId, requirePoseLiveness) {
  const configs = {
    center_to_left: {
      label: 'Turn left',
      hint: 'Slowly turn your head to the left.',
      arrow: 'left',
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'left'
        : displayed <= FACE_TARGET.cx - box.w * FACE_MOTION_GATE_X,
    },
    center_to_right: {
      label: 'Turn right',
      hint: 'Slowly turn your head to the right.',
      arrow: 'right',
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'right'
        : displayed >= FACE_TARGET.cx + box.w * FACE_MOTION_GATE_X,
    },
    left_to_right: {
      label: 'Turn right',
      hint: 'Now slowly turn your head to the right.',
      arrow: 'right',
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'right'
        : displayed >= FACE_TARGET.cx + box.w * FACE_MOTION_GATE_X,
    },
    right_to_left: {
      label: 'Turn left',
      hint: 'Now slowly turn your head to the left.',
      arrow: 'left',
      reached: (pose, box, displayed) => requirePoseLiveness
        ? pose && pose.pose === 'left'
        : displayed <= FACE_TARGET.cx - box.w * FACE_MOTION_GATE_X,
    },
  };
  return configs[phaseId] || null;
}

// One guided motion phase: prompt the user and wait until keypoint geometry
// shows the requested head pose. Records sampled box/yaw evidence.
async function runFaceMotionPhase(engine, centers, sizes, yaws, poses, phaseSeries, opts) {
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
        if (opts.phase && phaseSeries.length < 120) {
          const motionValue = opts.motionValue(box);
          pushFaceSeriesSample(phaseSeries, opts.phase, opts.flowStartedAt, motionValue, box.keypoints);
        }
        if (opts.collectPulse) opts.collectPulse(box);
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

const FLASH_FACE_W = 12;
const FLASH_FACE_H = 9;
const FLASH_BG_W = 4;
const FLASH_BG_H = 1;
const flashFaceCanvas = document.createElement('canvas');
flashFaceCanvas.width = FLASH_FACE_W;
flashFaceCanvas.height = FLASH_FACE_H;
const flashFaceCtx = flashFaceCanvas.getContext('2d', { willReadFrequently: true });
const flashBgCanvas = document.createElement('canvas');
flashBgCanvas.width = FLASH_BG_W;
flashBgCanvas.height = FLASH_BG_H;
const flashBgCtx = flashBgCanvas.getContext('2d', { willReadFrequently: true });

function rgbBytes(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 3);
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    out[j++] = data[i];
    out[j++] = data[i + 1];
    out[j++] = data[i + 2];
  }
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function setFlashOverlay(rgb) {
  if (!flashOverlayEl) return;
  if (rgb) {
    flashOverlayEl.hidden = false;
    flashOverlayEl.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    flashOverlayEl.style.opacity = '0.85';
  } else {
    flashOverlayEl.style.opacity = '0';
    flashOverlayEl.hidden = true;
  }
}

// Downscale the detected face region and a background strip from the live
// video into tiny RGB payloads the server can verify against the flash plan.
function sampleFlashPixels(box) {
  const vw = Math.max(1, videoEl.videoWidth || 640);
  const vh = Math.max(1, videoEl.videoHeight || 480);
  const sample = {};
  if (box && box.pixelBox) {
    const pb = box.pixelBox;
    const grow = 1.2;
    const cx = pb.x + pb.w / 2;
    const cy = pb.y + pb.h / 2;
    const w = Math.min(pb.w * grow, vw);
    const h = Math.min(pb.h * grow, vh);
    const x = Math.max(0, Math.min(cx - w / 2, vw - w));
    const y = Math.max(0, Math.min(cy - h / 2, vh - h));
    if (w > 8 && h > 8) {
      flashFaceCtx.drawImage(videoEl, x, y, w, h, 0, 0, FLASH_FACE_W, FLASH_FACE_H);
      sample.f = bytesToB64(rgbBytes(flashFaceCtx, FLASH_FACE_W, FLASH_FACE_H));
      sample.fb = [quantize(box.cx), quantize(box.cy), quantize(box.w)];
    }
  }
  const bgH = Math.max(4, Math.round(vh * 0.06));
  flashBgCtx.drawImage(videoEl, 0, 0, vw, bgH, 0, 0, FLASH_BG_W, FLASH_BG_H);
  sample.b = bytesToB64(rgbBytes(flashBgCtx, FLASH_BG_W, FLASH_BG_H));
  return sample;
}

// Full-screen color flashes light the user's face; the camera samples face and
// background pixels on the flash clock so the server can check the reflected
// light actually tracked a sequence only it issued.
const PULSE_ROI_W = 8;
const PULSE_ROI_H = 4;
const PULSE_MEASURE_MS = 14000;
// Reduced-motion challenges skip the flash stage, so the pulse check alone
// carries the liveness gate and measures longer to compensate.
const PULSE_MEASURE_MS_REDUCED = 20000;
const PULSE_SAMPLE_MS = 95;
// Pulse sampling also runs in the background during the motion phases, so the
// dedicated hold-still stage only tops up whatever window is still missing.
// The floor keeps the server's analysis tail mostly stillness; reduced-motion
// challenges rely on the pulse check alone so their tail is longer.
const PULSE_TOPUP_MIN_MS = 5000;
const PULSE_TOPUP_MIN_REDUCED_MS = 9000;
const PULSE_BG_MIN_GAP_MS = 110;
const PULSE_BG_MAX_SAMPLES = 300;
const pulseCanvas = document.createElement('canvas');
pulseCanvas.width = PULSE_ROI_W;
pulseCanvas.height = PULSE_ROI_H;
const pulseCtx = pulseCanvas.getContext('2d', { willReadFrequently: true });

// rPPG: forehead skin pixels shift green very slightly with each heartbeat.
// ~14s of green-channel means gives the server a spectral window on a signal
// only living skin produces — no screen flashing needed.
function samplePulseGreen(box) {
  if (!box || !box.pixelBox) return null;
  const vw = Math.max(1, videoEl.videoWidth || 640);
  const vh = Math.max(1, videoEl.videoHeight || 480);
  const pb = box.pixelBox;
  const w = Math.min(pb.w * 0.44, vw);
  const h = Math.min(pb.h * 0.16, vh);
  const x = Math.max(0, Math.min(pb.x + pb.w / 2 - w / 2, vw - w));
  const y = Math.max(0, Math.min(pb.y + pb.h * 0.05, vh - h));
  if (w < 6 || h < 4) return null;
  pulseCtx.drawImage(videoEl, x, y, w, h, 0, 0, PULSE_ROI_W, PULSE_ROI_H);
  const data = pulseCtx.getImageData(0, 0, PULSE_ROI_W, PULSE_ROI_H).data;
  let g = 0;
  const n = data.length / 4;
  for (let i = 1; i < data.length; i += 4) g += data[i];
  return g / n;
}

async function runPulseCheck(engine, measureMs, samples, t0) {
  const measureStart = performance.now();
  setStatus('Hold still', 'listening');
  promptNameEl.textContent = 'Hold still';
  while (faceChecking) {
    const now = performance.now() - measureStart;
    if (now > measureMs) break;
    const box = await detectStableFaceFrame(engine);
    const g = box && !box.stale ? samplePulseGreen(box) : null;
    if (g !== null) samples.push({ g: Math.round(g * 100) / 100, t: Math.round(performance.now() - t0) });
    const remaining = Math.max(1, Math.ceil((measureMs - now) / 1000));
    promptHintEl.textContent = `Keep your face lit and steady — ${remaining}s left`;
    await sleep(PULSE_SAMPLE_MS);
  }
  return samples;
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function runFlashPixelCheck(engine, flashPlan) {
  const t0 = performance.now();
  const last = flashPlan[flashPlan.length - 1];
  const endMs = last.o + last.d + 320;
  const samples = [];
  setStatus('Hold still', 'listening');
  promptNameEl.textContent = 'Hold still';
  promptHintEl.textContent = 'Keep your face in view while the screen flashes.';
  while (faceChecking) {
    const now = performance.now() - t0;
    if (now > endMs) break;
    const active = flashPlan.find((f) => now >= f.o && now <= f.o + f.d);
    setFlashOverlay(active ? active.c : null);
    const box = await detectStableFaceFrame(engine);
    const sample = sampleFlashPixels(box);
    sample.t = Math.round(now);
    samples.push(sample);
    await sleep(70);
  }
  setFlashOverlay(null);
  return samples;
}

async function runGuidedFaceCheck() {
  const engine = await ensureFaceEngine();
  const requirePoseLiveness = engine === 'mediapipe';
  const legacyEngine = !requirePoseLiveness;
  const motionValue = (box) => (requirePoseLiveness && box.pose ? box.pose.yaw : box.cx);

  const livenessChallenge = await apiJson('/api/liveness/challenge', { reducedMotion: prefersReducedMotion() });
  const motionPlan = Array.isArray(livenessChallenge.plan) && livenessChallenge.plan.length >= 3
    ? livenessChallenge.plan
    : ['center_hold', 'center_to_left', 'left_to_right'];
  const flashPlan = Array.isArray(livenessChallenge.flashPlan) ? livenessChallenge.flashPlan : null;
  faceChecking = true;
  setStartButton('Verification in progress', true);
  promptEmojiEl.textContent = '🙂';
  progressEl.style.width = '0%';

  const centers = [];
  const sizes = [];
  const yaws = [];
  const poses = [];
  const phaseSeries = [];
  const pulseSeries = [];
  const startedAt = performance.now();
  let lastPulseT = -1;
  const collectPulse = (box) => {
    if (!box || box.stale || pulseSeries.length >= PULSE_BG_MAX_SAMPLES) return;
    const t = performance.now() - startedAt;
    if (t - lastPulseT < PULSE_BG_MIN_GAP_MS) return;
    const g = samplePulseGreen(box);
    if (g !== null) {
      pulseSeries.push({ g: Math.round(g * 100) / 100, t: Math.round(t) });
      lastPulseT = t;
    }
  };
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
        if (centeredFrames > 0 && phaseSeries.length < 120) {
          pushFaceSeriesSample(phaseSeries, 'center_hold', startedAt, motionValue(box), box.keypoints);
        }
        collectPulse(box);
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
    progressEl.style.width = `${Math.round(100 / motionPlan.length)}%`;

    for (let step = 1; step < motionPlan.length; step++) {
      const phaseId = motionPlan[step];
      const phaseUi = faceMotionPhaseConfig(phaseId, requirePoseLiveness);
      if (!phaseUi) {
        throw new Error('Face check could not start. Refresh and try again.');
      }
      const moved = await runFaceMotionPhase(engine, centers, sizes, yaws, poses, phaseSeries, {
        label: phaseUi.label,
        hint: phaseUi.hint,
        arrow: phaseUi.arrow,
        deadline,
        flowStartedAt: startedAt,
        phase: phaseId,
        motionValue,
        reached: phaseUi.reached,
        collectPulse,
      });
      if (!moved) {
        throw new Error(`Face motion timed out. ${phaseUi.hint} Then try again.`);
      }
      progressEl.style.width = `${Math.round(((step + 1) / motionPlan.length) * 100)}%`;
    }

    if (!faceChecking) return;

    promptEmojiEl.textContent = '💓';
    const pulseTargetMs = flashPlan ? PULSE_MEASURE_MS : PULSE_MEASURE_MS_REDUCED;
    const pulseElapsedMs = pulseSeries.length ? pulseSeries[pulseSeries.length - 1].t : 0;
    const pulseTopUpMinMs = flashPlan ? PULSE_TOPUP_MIN_MS : PULSE_TOPUP_MIN_REDUCED_MS;
    await runPulseCheck(engine, Math.max(pulseTopUpMinMs, pulseTargetMs - pulseElapsedMs), pulseSeries, startedAt);
    if (!faceChecking) return;

    if (centers.length < 8 || (requirePoseLiveness && yaws.length < 8)) {
      throw new Error('No face was detected. Make sure your face is lit and centered, then try again.');
    }
    const yawRange = yaws.length ? Math.max(...yaws) - Math.min(...yaws) : 0;
    const poseSequenceOk = poses.includes('center') && poses.includes('left') && poses.includes('right');
    if (requirePoseLiveness && (!poseSequenceOk || yawRange < YAW_MOTION_RANGE_MIN)) {
      throw new Error('Head turn motion was too small. Face forward, then turn left and right when prompted.');
    }

    const phaseBuckets = Object.fromEntries(motionPlan.map((id) => [id, []]));
    for (const sample of phaseSeries) {
      if (phaseBuckets[sample.phase]) phaseBuckets[sample.phase].push(sample);
    }
    const phases = motionPlan.map((id) => summarizeLivenessPhase(id, phaseBuckets[id]));
    const livenessError = evaluateFaceMotionLiveness(phases, { legacy: legacyEngine });
    if (livenessError) throw new Error(livenessError);

    setStatus('Checking…', 'listening');
    promptNameEl.textContent = 'Checking…';
    promptHintEl.textContent = 'Confirming your liveness check.';
    drawFaceGuide(null, { state: 'good' });

    const durationMs = Math.min(15000, Math.max(900, Math.round(performance.now() - startedAt)));
    const centerMotion = Math.max(...centers) - Math.min(...centers);
    const sizeMotion = Math.max(...sizes) - Math.min(...sizes);
    const motionSeries = phaseSeries.map((sample) => {
      const entry = { p: sample.phase, t: sample.t, v: sample.v };
      if (Number.isFinite(sample.m)) entry.m = sample.m;
      if (Number.isFinite(sample.e)) entry.e = sample.e;
      return entry;
    });
    const seriesDigest = await livenessSeriesDigest(livenessChallenge.challengeId, motionSeries);
    const verificationBody = {
      challengeId: livenessChallenge.challengeId,
      durationMs,
      faceFrames: centers.length,
      motionScore: Math.max(yawRange, centerMotion, sizeMotion),
      phases,
      motionSeries,
      seriesDigest,
      pulseSeries,
      legacyEngine,
    };
    let result;
    try {
      result = await apiJson('/api/liveness/verify', verificationBody);
    } catch (error) {
      if (!error.data?.flashAvailable || !flashPlan?.length) throw error;
      const accepted = await askForFlashFallback();
      if (!accepted) {
        stopCamera();
        showChoicePanel('back');
        return;
      }
      promptEmojiEl.textContent = '💡';
      progressEl.style.width = '100%';
      const pixelSeries = await runFlashPixelCheck(engine, flashPlan);
      if (!faceChecking) return;
      setStatus('Checking…', 'listening');
      promptNameEl.textContent = 'Checking…';
      promptHintEl.textContent = 'Confirming the backup liveness check.';
      result = await apiJson('/api/liveness/verify', {
        ...verificationBody,
        flashFallback: true,
        pixelSeries,
      });
    }
    verificationToken = result.verificationToken;
    await confirmProtectedAction();
  } finally {
    faceChecking = false;
    setFlashOverlay(null);
    recentFaceBox = null;
    recentFaceBoxAt = 0;
  }
}

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

  setZoeIdButtonsDisabled(true);
  try {
    await createFreshPasskey(idResultEl);
    if (!pendingZoeIdRegistration) setZoeIdButtonsDisabled(false);
  } catch (err) {
    idResultEl.textContent = err.message || 'Could not register Zoe ID.';
    setZoeIdButtonsDisabled(false);
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

// Boot splash: cover first paint with the Zoe mark while the page and the
// face model warm up; reveal the card once ready (or after a hard cap).
(function bootSplash() {
  if (!bootLoaderEl) return;
  const MIN_MS = 750;
  const HARD_CAP_MS = 5000;
  const start = performance.now();
  const warmModel = fetch('models/blaze_face_short_range.tflite', { cache: 'force-cache' })
    .then((r) => r.ok ? r.arrayBuffer() : null)
    .catch(() => null);
  const pageLoad = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve, { once: true });
  });
  const minTime = new Promise((resolve) => setTimeout(resolve, MIN_MS));
  const cap = new Promise((resolve) => setTimeout(resolve, HARD_CAP_MS));
  let revealed = false;
  const reveal = () => {
    if (revealed || !bootLoaderEl.isConnected) return;
    revealed = true;
    bootLoaderEl.classList.add('done');
    bootLoaderEl.addEventListener('transitionend', () => bootLoaderEl.remove(), { once: true });
    setTimeout(() => bootLoaderEl.isConnected && bootLoaderEl.remove(), 1000);
  };
  Promise.race([Promise.all([pageLoad, warmModel, minTime]), cap]).then(reveal);
})();
// Recompute when the card's own size changes (panel switches, camera turning on).
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fitCardToViewport).observe(cardEl);
}
fitCardToViewport();
