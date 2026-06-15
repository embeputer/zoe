// Zoe - human-presence verification.
// The browser performs local hand-pose detection, but the server owns
// challenge order, replay state, and the final verification token.

const HOLD_FRAMES = 8;
const COOLDOWN_MS = 1200;
const FRAME_SAMPLE_MS = 33;

let stream = null;
let handsModel = null;
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
const methodLabelEl = $('method-label');
const methodHintEl = $('method-hint');
const verificationTitleEl = $('verification-title');
const startBtn = $('start-btn');
const resetBtn = $('reset-btn');
const cardEl = $('captcha-card');
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
}

function showError(msg) {
  setStatus('Error', 'error');
  promptHintEl.textContent = msg;
  setStartButton('Start check', false);
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

function showChoicePanel() {
  methodChoiceEl.hidden = false;
  zoeIdPanel.hidden = true;
  dialogEl.hidden = true;
  verifiedEl.hidden = true;
  choiceResultEl.textContent = '';
  zoeIntroEl.setAttribute('aria-hidden', 'true');
  zoeVerifyBtn.disabled = true;
  requestAnimationFrame(() => {
    cardEl.classList.remove('id-mode');
    cardEl.classList.remove('verify-mode');
    cardEl.classList.add('choice-mode');
    choiceFaceBtn.focus();
  });
}

function showZoeIdPanel(returnTarget = 'choice') {
  zoeIdReturnTarget = returnTarget;
  methodChoiceEl.hidden = true;
  zoeIdPanel.hidden = false;
  dialogEl.hidden = true;
  verifiedEl.hidden = true;
  idResultEl.textContent = '';
  zoeIntroEl.setAttribute('aria-hidden', 'true');
  zoeVerifyBtn.disabled = true;
  requestAnimationFrame(() => {
    cardEl.classList.remove('choice-mode');
    cardEl.classList.remove('verify-mode');
    cardEl.classList.add('id-mode');
    idUseBtn.focus();
  });
}

function showVerificationPanel() {
  methodChoiceEl.hidden = true;
  zoeIdPanel.hidden = true;
  dialogEl.hidden = false;
  verifiedEl.hidden = true;
  zoeIntroEl.setAttribute('aria-hidden', 'true');
  zoeVerifyBtn.disabled = true;
  requestAnimationFrame(() => {
    cardEl.classList.remove('choice-mode');
    cardEl.classList.remove('id-mode');
    cardEl.classList.add('verify-mode');
    startBtn.focus();
  });
}

function showIntroPanel() {
  zoeIdReturnTarget = 'choice';
  cardEl.classList.remove('choice-mode');
  cardEl.classList.remove('id-mode');
  cardEl.classList.remove('verify-mode');
  zoeIntroEl.removeAttribute('aria-hidden');
  zoeVerifyBtn.disabled = false;
  methodChoiceEl.hidden = true;
  zoeIdPanel.hidden = true;
  dialogEl.hidden = true;
}

function continueFromIntro() {
  if (isMobileLayout()) {
    selectPrimaryMethod('face');
    showVerificationPanel();
    return;
  }

  showChoicePanel();
}

function choosePrimaryMethod(method) {
  selectPrimaryMethod(method);
  showVerificationPanel();
}

function leaveZoeIdPanel() {
  if (zoeIdReturnTarget === 'verification') {
    showVerificationPanel();
    return;
  }

  showChoicePanel();
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

  methodLabelEl.textContent = isFace ? 'Face motion' : 'Gesture check';
  methodHintEl.textContent = isFace ? '1 quick step' : '3 quick steps';
  verificationTitleEl.textContent = isFace ? 'Face verification' : 'Hand verification';
  promptEmojiEl.textContent = isFace ? '🙂' : '-';
  promptNameEl.textContent = isFace ? 'Move gently left and right' : 'Click "Start" to begin';
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
    await apiJson('/api/protected-action', { verificationToken });
    stopDetection();
    stopCamera();
    methodChoiceEl.hidden = true;
    zoeIdPanel.hidden = true;
    dialogEl.hidden = true;
    verifiedEl.hidden = false;
    cardEl.classList.remove('choice-mode');
    cardEl.classList.remove('id-mode');
    cardEl.classList.add('verify-mode');
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
  ctx.save();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.translate(canvasEl.width, 0);
  ctx.scale(-1, 1);
  if (results.image) ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);
  ctx.restore();

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
  ctx.save();
  ctx.translate(canvasEl.width, 0);
  ctx.scale(-1, 1);
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    hands.forEach((hand) => {
      window.drawConnectors(ctx, hand, window.HAND_CONNECTIONS, { color: '#5b8cff', lineWidth: 3 });
      window.drawLandmarks(ctx, hand, { color: '#7b5bff', lineWidth: 1, radius: 4 });
    });
  }
  ctx.restore();

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
  promptNameEl.textContent = 'Face motion';
  promptHintEl.textContent = 'Move your face gently left, then right.';
  setStatus('Starting camera...', 'listening');
  await runFaceMotionCheck({ primary: true });
}

startBtn.addEventListener('click', async () => {
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
  }
});

assistBtn.addEventListener('click', () => {
  const expanded = assistPanel.hidden;
  assistPanel.hidden = !expanded;
  assistBtn.setAttribute('aria-expanded', String(expanded));
  if (expanded) {
    assistResultEl.textContent = '';
    showCameraHelp('You can keep trying the camera check, or choose a different check below.');
  }
});

function setAssistButtonsDisabled(disabled) {
  [choiceIdBtn, mobileIdBtn, idUseBtn, idRegisterBtn, idBackBtn, textChallengeBtn, audioChallengeBtn, audioRepeatBtn, fallbackSubmitBtn].forEach((button) => {
    button.disabled = disabled;
  });
}

async function registerPasskey() {
  const options = await apiJson('/api/passkey/register/options');
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
  await apiJson('/api/passkey/reset');
  resultEl.textContent = 'Registering Zoe ID on this browser...';
  await registerPasskey();
  resultEl.textContent = 'ID passkey saved. Asking it to vouch for you now...';
  await authenticatePasskey();
}

async function useZoeId(resultEl = assistResultEl) {
  if (!window.PublicKeyCredential) {
    resultEl.textContent = 'This browser does not support passkeys here.';
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

async function runFaceMotionCheck(options = {}) {
  if (!('FaceDetector' in window)) {
    throw new Error('Face motion check is not available in this browser. Try Zoe ID or emergency text/audio.');
  }

  if (!stream) await startCamera();
  const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
  const startedAt = performance.now();
  const centers = [];
  const sizes = [];
  if (!options.primary) assistResultEl.textContent = 'Move your face gently left, then right.';
  setStatus('Face motion', 'listening');

  while (performance.now() - startedAt < 3200) {
    const faces = await detector.detect(videoEl).catch(() => []);
    if (faces.length) {
      const box = faces[0].boundingBox;
      centers.push((box.x + box.width / 2) / Math.max(1, videoEl.videoWidth || 640));
      sizes.push(box.width / Math.max(1, videoEl.videoWidth || 640));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const centerMotion = centers.length ? Math.max(...centers) - Math.min(...centers) : 0;
  const sizeMotion = sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 0;
  const result = await apiJson('/api/liveness/verify', {
    durationMs: Math.round(performance.now() - startedAt),
    faceFrames: centers.length,
    motionScore: Math.max(centerMotion, sizeMotion),
  });
  verificationToken = result.verificationToken;
  await confirmProtectedAction();
}

resetBtn.addEventListener('click', () => {
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

  verifiedEl.hidden = true;
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
  if (!window.PublicKeyCredential) {
    idResultEl.textContent = 'This browser does not support passkeys here.';
    return;
  }

  setAssistButtonsDisabled(true);
  try {
    await createFreshPasskey(idResultEl);
  } catch (err) {
    idResultEl.textContent = err.message || 'Could not register Zoe ID.';
    setAssistButtonsDisabled(false);
  }
});
idBackBtn.addEventListener('click', leaveZoeIdPanel);
mobileIdBtn.addEventListener('click', () => showZoeIdPanel('verification'));
zoeVerifyBtn.addEventListener('click', continueFromIntro);
selectPrimaryMethod(isMobileLayout() ? 'face' : 'hand');
