// Shared face-box calibration used by app.js and the debug camera lab.
// Loaded as a plain script — these top-level declarations are globals.
// Canonical box shape: { x, y, w, h } in video-frame pixels.

function pointToPixel(point, frameWidth, frameHeight) {
  return {
    x: point.x <= 1 ? point.x * frameWidth : point.x,
    y: point.y <= 1 ? point.y * frameHeight : point.y,
  };
}

// Grow the detector box until it contains the face keypoints: raw detector
// boxes sit slightly off the skin region, while the keypoints mark the
// features the pulse/flash sampling regions actually read.
function fitBoxToKeypoints(box, keypoints, frameWidth, frameHeight) {
  const points = (keypoints || [])
    .map((point) => pointToPixel(point, frameWidth, frameHeight))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return box;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.min(frameWidth, Math.max(box.w, maxX - minX + box.w * 0.16));
  const h = Math.min(frameHeight, Math.max(box.h, maxY - minY + box.h * 0.16));
  const x = Math.min(Math.max(0, (minX + maxX - w) / 2), Math.max(0, frameWidth - w));
  const y = Math.min(Math.max(0, (minY + maxY - h) / 2), Math.max(0, frameHeight - h));
  return { ...box, x, y, w, h };
}

function calibratedFaceBox(box, keypoints, frameWidth, frameHeight) {
  // Blaze's raw box already tracks the face; keep it frame-clamped and let
  // landmark fitting absorb residual detector offset instead of hard shifts.
  return fitBoxToKeypoints({
    x: Math.min(Math.max(0, box.x), Math.max(0, frameWidth - box.w)),
    y: Math.min(Math.max(0, box.y), Math.max(0, frameHeight - box.h)),
    w: box.w,
    h: box.h,
  }, keypoints, frameWidth, frameHeight);
}

// True when the keypoint span's center diverges from the box center by more
// than half a box dimension — an inconsistent read (e.g. a shoulder edge
// scored as a face) that landmark fitting would land off the face.
function detectorBoxDisplaced(box, keypoints, frameWidth, frameHeight) {
  const points = (keypoints || [])
    .map((point) => pointToPixel(point, frameWidth, frameHeight))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3 || !box || box.w < 1) return false;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spanCx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const spanCy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const boxCx = box.x + box.w / 2;
  const boxCy = box.y + box.h / 2;
  return Math.abs(spanCx - boxCx) > box.w * 0.55 || Math.abs(spanCy - boxCy) > box.h * 0.55;
}

// Fraction of the keypoint span lying outside the box on the worst axis —
// 0 when the box fully contains the landmarks. When landmark fitting cannot
// absorb a displaced detector box, this reports how much of the face's
// keypoint span still spills out.
function keypointSpanOutsideBox(box, keypoints, frameWidth, frameHeight) {
  const points = (keypoints || [])
    .map((point) => pointToPixel(point, frameWidth, frameHeight))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 3) return 0;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const coveredX = Math.max(0, Math.min(maxX, box.x + box.w) - Math.max(minX, box.x));
  const coveredY = Math.max(0, Math.min(maxY, box.y + box.h) - Math.max(minY, box.y));
  return Math.max(
    spanX > 0 ? (spanX - coveredX) / spanX : 0,
    spanY > 0 ? (spanY - coveredY) / spanY : 0,
  );
}

// Forehead pulse ROI shared by the app's rPPG sampling and the camera lab so
// both read green-channel means over the same skin region.
function pulseRoi(box, frameWidth, frameHeight) {
  const w = Math.min(box.w * 0.44, frameWidth);
  const h = Math.min(box.h * 0.16, frameHeight);
  const x = Math.max(0, Math.min(box.x + box.w / 2 - w / 2, frameWidth - w));
  const y = Math.max(0, Math.min(box.y + box.h * 0.05, frameHeight - h));
  return { x, y, w, h };
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    pointToPixel,
    fitBoxToKeypoints,
    calibratedFaceBox,
    detectorBoxDisplaced,
    keypointSpanOutsideBox,
    pulseRoi,
  };
}
