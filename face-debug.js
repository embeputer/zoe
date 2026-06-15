const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';
const TASKS_VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

const videoEl = document.getElementById('debug-video');
const canvasEl = document.getElementById('debug-overlay');
const ctx = canvasEl.getContext('2d');
const statusEl = document.getElementById('debug-status');
const restartBtn = document.getElementById('restart-btn');
const modelSelect = document.getElementById('model-select');
const mirrorToggle = document.getElementById('mirror-toggle');
const mirrorOverlayToggle = document.getElementById('mirror-overlay-toggle');

let stream = null;
let detector = null;
let running = false;
let frameCount = 0;
let lastDetections = 0;
let lastScore = 0;
let lastError = '';

const FACE_BOX_SHIFT_X = -1.0;
const FACE_BOX_SHIFT_Y = -0.55;
const FACE_BOX_HEIGHT_SCALE = 1.02;

function setStatus(message) {
  statusEl.innerHTML = message;
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
  if (w <= 1 && h <= 1 && x <= 1 && y <= 1) {
    x *= vw;
    y *= vh;
    w *= vw;
    h *= vh;
  }
  return { x, y, w, h };
}

function calibratedFaceBox(box, vw, vh) {
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

async function loadDetector() {
  setStatus('Loading MediaPipe Tasks Vision...');
  const vision = await import(TASKS_VISION_URL);
  const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
  detector = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelSelect.value },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.3,
  });
}

async function startCamera() {
  stopCamera();
  setStatus('Starting camera...');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  await new Promise((resolve) => setTimeout(resolve, 350));
  canvasEl.width = videoEl.videoWidth || 640;
  canvasEl.height = videoEl.videoHeight || 480;
}

function stopCamera() {
  running = false;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  videoEl.srcObject = null;
}

function drawDetections(detections, vw, vh) {
  ctx.clearRect(0, 0, vw, vh);
  ctx.save();
  if (mirrorToggle.checked) {
    ctx.translate(vw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(videoEl, 0, 0, vw, vh);
  ctx.restore();

  ctx.save();
  if (mirrorOverlayToggle.checked) {
    ctx.translate(vw, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineWidth = 4;
  ctx.font = '18px system-ui, -apple-system, Segoe UI, sans-serif';

  detections.forEach((detection, index) => {
    const rawBox = detectionBox(detection, vw, vh);
    const box = calibratedFaceBox(rawBox, vw, vh);
    const score = detectionScore(detection);
    ctx.strokeStyle = '#ff9f1c';
    ctx.fillStyle = '#ff9f1c';
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(rawBox.x, rawBox.y, rawBox.w, rawBox.h);
    ctx.fillText(`raw ${index + 1}`, rawBox.x + 6, Math.max(22, rawBox.y - 30));

    const color = index === 0 ? '#00ff7b' : '#ffd43b';
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillText(`cal ${index + 1}: ${(score * 100).toFixed(1)}%`, box.x + 6, Math.max(22, box.y - 8));

    (detection.keypoints || []).forEach((rawPoint, pointIndex) => {
      const point = pointToPixel(rawPoint, vw, vh);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(String(pointIndex), point.x + 9, point.y + 5);
    });
  });

  ctx.restore();
}

function loop() {
  if (!running) return;
  const vw = videoEl.videoWidth || 640;
  const vh = videoEl.videoHeight || 480;
  canvasEl.width = vw;
  canvasEl.height = vh;

  let detections = [];
  try {
    const result = detector.detectForVideo(videoEl, performance.now());
    detections = result.detections || [];
    lastError = '';
  } catch (err) {
    lastError = err.message || String(err);
  }

  frameCount++;
  lastDetections = detections.length;
  lastScore = detections[0] ? detectionScore(detections[0]) : 0;
  drawDetections(detections, vw, vh);
  setStatus(
    `<strong>frames:</strong> ${frameCount} &nbsp; ` +
    `<strong>detections:</strong> ${lastDetections} &nbsp; ` +
    `<strong>top score:</strong> ${lastDetections ? `${(lastScore * 100).toFixed(1)}%` : 'none'} &nbsp; ` +
    `<strong>model:</strong> ${modelSelect.options[modelSelect.selectedIndex].text} &nbsp; ` +
    `<strong>image mirrored:</strong> ${mirrorToggle.checked ? 'yes' : 'no'} &nbsp; ` +
    `<strong>overlay mirrored:</strong> ${mirrorOverlayToggle.checked ? 'yes' : 'no'}<br>` +
    `<strong>orange:</strong> raw Blaze box &nbsp; <strong>green:</strong> calibrated app box &nbsp; ` +
    `<strong>calibration:</strong> x ${FACE_BOX_SHIFT_X}w, y ${FACE_BOX_SHIFT_Y}h` +
    (lastError ? `<br><strong>error:</strong> ${lastError}` : '')
  );
  requestAnimationFrame(loop);
}

async function restart() {
  try {
    running = false;
    frameCount = 0;
    await loadDetector();
    await startCamera();
    running = true;
    loop();
  } catch (err) {
    setStatus(`<strong>error:</strong> ${err.message || err}`);
  }
}

restartBtn.addEventListener('click', restart);
modelSelect.addEventListener('change', restart);
mirrorToggle.addEventListener('change', () => {
  // The camera frame is drawn into the canvas, so the next frame will reflect
  // the mirror setting automatically.
});
mirrorOverlayToggle.addEventListener('change', () => {
  // The detector overlay is drawn into the canvas, so the next frame will reflect
  // the mirror setting automatically.
});

restart();

