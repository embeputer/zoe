const video = document.querySelector('#video');
const overlay = document.querySelector('#overlay');
const overlayContext = overlay.getContext('2d');
const sampleCanvas = document.createElement('canvas');
const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
const startButton = document.querySelector('#start');
const resetButton = document.querySelector('#reset');
const flashButton = document.querySelector('#flash');
const flashOverlay = document.querySelector('#flash-overlay');
const faceStatus = document.querySelector('#face-status');
const pulseStatus = document.querySelector('#pulse-status');
const pulseDetail = document.querySelector('#pulse-detail');
const bpm = document.querySelector('#bpm');
const quality = document.querySelector('#quality');
const baseline = document.querySelector('#baseline');
const flashResults = document.querySelector('#flash-results');

const metrics = window.ZoeDebugMetrics;
const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const TASKS_VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const FACE_MODEL_URL = '/models/blaze_face_short_range.tflite';
const SAMPLE_INTERVAL_MS = 100;
const PULSE_WINDOW_MS = 12000;
const FLASH_COLORS = [
  { name: 'Red', className: 'flash-red', rgb: [255, 72, 72] },
  { name: 'Green', className: 'flash-green', rgb: [72, 255, 124] },
  { name: 'Blue', className: 'flash-blue', rgb: [72, 120, 255] },
];

let detector = null;
let stream = null;
let running = false;
let pulseSamples = [];
let lastSampleAt = 0;
let lastVideoTime = -1;
let currentFace = null;
let currentFlashSamples = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initDetector() {
  const vision = await import(TASKS_VISION_URL);
  const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
  detector = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL_URL },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  });
}

function bestFace() {
  if (!detector || video.readyState < 2 || video.currentTime === lastVideoTime) return currentFace;
  lastVideoTime = video.currentTime;
  const result = detector.detectForVideo(video, performance.now());
  const detections = result.detections || [];
  let best = null;
  for (const detection of detections) {
    const box = detection.boundingBox;
    const score = Number(detection.categories?.[0]?.score || 0);
    if (!box || score < 0.5) continue;
    const candidate = {
      x: box.originX,
      y: box.originY,
      width: box.width,
      height: box.height,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  currentFace = best;
  return best;
}

function drawFace(face) {
  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  overlayContext.clearRect(0, 0, width, height);
  overlayContext.strokeStyle = face ? '#56e39f' : '#ffffff88';
  overlayContext.lineWidth = Math.max(3, width / 180);
  overlayContext.setLineDash([12, 9]);
  overlayContext.beginPath();
  overlayContext.ellipse(width / 2, height * 0.46, width * 0.2, height * 0.34, 0, 0, Math.PI * 2);
  overlayContext.stroke();
  overlayContext.setLineDash([]);
  if (face) {
    overlayContext.strokeStyle = '#56e39f';
    overlayContext.strokeRect(face.x, face.y, face.width, face.height);
  }
}

function faceRegionMean(face) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || !face) return null;
  if (sampleCanvas.width !== width || sampleCanvas.height !== height) {
    sampleCanvas.width = width;
    sampleCanvas.height = height;
  }
  sampleContext.drawImage(video, 0, 0, width, height);
  const x = Math.max(0, Math.round(face.x + face.width * 0.3));
  const y = Math.max(0, Math.round(face.y + face.height * 0.12));
  const roiWidth = Math.max(8, Math.min(width - x, Math.round(face.width * 0.4)));
  const roiHeight = Math.max(8, Math.min(height - y, Math.round(face.height * 0.18)));
  const pixels = sampleContext.getImageData(x, y, roiWidth, roiHeight).data;
  const totals = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    totals[0] += pixels[index];
    totals[1] += pixels[index + 1];
    totals[2] += pixels[index + 2];
    count += 1;
  }
  return totals.map((total) => total / Math.max(1, count));
}

function renderPulse(now) {
  pulseSamples = pulseSamples.filter((sample) => now - sample.t <= PULSE_WINDOW_MS);
  const relative = pulseSamples.map((sample) => ({
    t: sample.t - pulseSamples[0].t,
    g: sample.g,
  }));
  const result = metrics.pulseMetrics(relative);
  if (result.detected) {
    pulseStatus.textContent = 'Heartbeat found';
    pulseDetail.textContent = result.reason;
    bpm.textContent = `${result.bpm} BPM`;
    quality.textContent = `${result.quality}%`;
  } else {
    pulseStatus.textContent = 'Detecting';
    pulseDetail.textContent = result.reason;
    bpm.textContent = result.bpm ? `${result.bpm} BPM candidate` : '—';
    quality.textContent = Number.isFinite(result.quality) ? `${result.quality}%` : '—';
  }
}

function frame(now) {
  if (!running) return;
  const face = bestFace();
  drawFace(face);
  faceStatus.textContent = face ? `${Math.round(face.score * 100)}% confidence` : 'No face found';
  if (face && now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    const rgb = faceRegionMean(face);
    if (rgb) {
      pulseSamples.push({ t: now, g: rgb[1] });
      if (currentFlashSamples) currentFlashSamples.push(rgb);
      lastSampleAt = now;
      renderPulse(now);
    }
  }
  requestAnimationFrame(frame);
}

async function startCamera() {
  startButton.disabled = true;
  startButton.textContent = 'Starting camera';
  try {
    await initDetector();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    running = true;
    resetButton.disabled = false;
    flashButton.disabled = false;
    startButton.textContent = 'Camera running';
    requestAnimationFrame(frame);
  } catch (error) {
    startButton.disabled = false;
    startButton.textContent = 'Try camera again';
    faceStatus.textContent = 'Camera error';
    pulseDetail.textContent = error.message;
  }
}

function resetPulse() {
  pulseSamples = [];
  pulseStatus.textContent = 'Detecting';
  pulseDetail.textContent = 'New sample started';
  bpm.textContent = '—';
  quality.textContent = '—';
}

async function collectWindow(durationMs) {
  const samples = [];
  currentFlashSamples = samples;
  await sleep(durationMs);
  currentFlashSamples = null;
  return samples;
}

async function runFlashTest() {
  flashButton.disabled = true;
  flashButton.textContent = 'Collecting baseline';
  flashResults.innerHTML = '<span class="small">Keep looking at the camera</span>';
  const baselineStarted = performance.now();
  const baselineSamples = await collectWindow(1200);
  const baselineDuration = performance.now() - baselineStarted;
  baseline.textContent = `${baselineSamples.length} samples / ${(baselineDuration / 1000).toFixed(1)}s`;
  const results = [];
  for (const color of FLASH_COLORS) {
    flashButton.textContent = `Testing ${color.name.toLowerCase()}`;
    flashOverlay.className = color.className;
    flashOverlay.hidden = false;
    await sleep(150);
    const samples = await collectWindow(650);
    flashOverlay.hidden = true;
    await sleep(450);
    results.push({ color, sampleCount: samples.length, result: metrics.flashMetrics(baselineSamples, samples, color.rgb) });
  }
  flashResults.replaceChildren(...results.map(({ color, sampleCount, result }) => {
    const row = document.createElement('div');
    row.className = 'flash-row';
    const swatch = document.createElement('span');
    swatch.className = `swatch ${color.className}`;
    const name = document.createElement('span');
    name.textContent = `${color.name} (${sampleCount} samples)`;
    const value = document.createElement('strong');
    value.textContent = result
      ? `${Math.round(result.cosine * 100)}% direction / ${result.strength.toFixed(2)}× strength`
      : 'No usable response';
    row.append(swatch, name, value);
    return row;
  }));
  flashButton.disabled = false;
  flashButton.textContent = 'Run flash test again';
}

startButton.addEventListener('click', startCamera);
resetButton.addEventListener('click', resetPulse);
flashButton.addEventListener('click', runFlashTest);
