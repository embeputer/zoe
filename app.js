// RealHands - gesture-based human verification.
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

const $ = (id) => document.getElementById(id);

const videoEl = $('video');
const canvasEl = $('overlay');
const ctx = canvasEl.getContext('2d');
const statusEl = $('status-pill');
const promptEmojiEl = $('prompt-gesture');
const promptNameEl = $('prompt-name');
const promptHintEl = $('prompt-hint');
const progressEl = $('progress-bar');
const startBtn = $('start-btn');
const resetBtn = $('reset-btn');
const dialogEl = $('dialog');
const verifiedEl = $('verified');
const assistBtn = $('assist-btn');
const assistPanel = $('assist-panel');
const assistRequestBtn = $('assist-request-btn');
const assistResultEl = $('assist-result');
const cameraHelpEl = $('camera-help');
const cameraHelpTextEl = $('camera-help-text');
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
  if (okDist < 0.05 && middle && ring && pinky) return 'ok';
  if (okDist < 0.05 && !middle && !ring && !pinky) return 'ily';
  if (!thumb && index && !middle && !ring && pinky) return 'rock';
  if (thumb && index && middle && !ring && !pinky) return 'three';
  if (thumb && !index && !middle && !ring && pinky) return 'call_me';
  if (index && middle && !ring && !pinky) return 'peace';
  if (index && !middle && !ring && !pinky) return 'point';
  if (!index && !middle && !ring && !pinky && !thumb) return 'fist';
  return null;
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
    maxNumHands: 1,
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
  setStartButton('Start verification', false);
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

function showPrompt(step) {
  promptEmojiEl.textContent = step.emoji;
  promptNameEl.textContent = step.name;
  promptHintEl.textContent = step.hint;
}

function updateChecklistUI() {
  checkEls.forEach((el, i) => {
    el.classList.remove('active', 'done');
    el.hidden = i >= totalSteps;
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

function sampleLandmarks(lm, detectedGesture) {
  if (landmarkSamples.length >= 24) return;
  const selected = [LM.wrist, LM.thumbTip, LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip];
  landmarkSamples.push({
    t: Math.round(performance.now() - stepStartedAt),
    g: detectedGesture,
    p: selected.map((idx) => [quantize(lm[idx].x), quantize(lm[idx].y), quantize(lm[idx].z)]),
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
    dialogEl.hidden = true;
    verifiedEl.hidden = false;
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
    window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS, { color: '#5b8cff', lineWidth: 3 });
    window.drawLandmarks(ctx, lm, { color: '#7b5bff', lineWidth: 1, radius: 4 });
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
  } else {
    detectedGesture = classifyGesture(lm);
    matched = detectedGesture === currentStep.id;
  }

  sampleLandmarks(lm, detectedGesture);

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
      showCameraHelp('If the pose is right but not landing, rotate your wrist slightly and move farther from the lens.');
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

async function doInit() {
  if (location.protocol === 'file:') {
    throw new Error('Run RealHands through the server with `npm start`; file:// cannot use server-bound verification.');
  }
  if (!handsModel) await initMediaPipe();
  if (!stream) await startCamera();
  if (!detecting) await startDetection();
  await startVerification();
}

startBtn.addEventListener('click', async () => {
  setStartButton('Starting camera...', true);
  setStatus('Initializing...', 'listening');

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Camera or server init timed out.')), 15000)
  );

  try {
    if (!window.Hands) throw new Error('MediaPipe Hands failed to load. Check your network and reload.');
    await Promise.race([doInit(), timeout]);
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
    showCameraHelp('You can keep trying the camera check, or use the assisted path below.');
  }
});

assistRequestBtn.addEventListener('click', async () => {
  assistRequestBtn.disabled = true;
  assistResultEl.textContent = 'Opening an assisted check...';
  try {
    const result = await apiJson('/api/accessibility-request', {
      challengeId: currentChallengeId,
      completedSteps,
      reason: 'camera_or_accessibility',
    });
    stopDetection();
    stopCamera();
    assistResultEl.textContent = `Request ${result.requestId} is open. This path needs a human or higher-trust fallback before access is granted.`;
    setStatus('Assisted path opened', 'cooldown');
  } catch (err) {
    assistRequestBtn.disabled = false;
    assistResultEl.textContent = err.message || 'Could not open an assisted check.';
  }
});

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
  assistRequestBtn.disabled = false;
  assistResultEl.textContent = '';

  verifiedEl.hidden = true;
  dialogEl.hidden = false;

  setStartButton('Start verification', false);
  promptEmojiEl.textContent = '-';
  promptNameEl.textContent = 'Click "Start" to begin';
  promptHintEl.textContent = '';
  checkEls.forEach((el) => {
    el.classList.remove('active', 'done');
    el.hidden = false;
    el.querySelector('.label').textContent = '-';
  });
  setStatus('Idle', 'idle');
});
