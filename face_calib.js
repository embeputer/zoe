// Shared face-box calibration used by app.js and the debug camera lab.
// Loaded as a plain script — these top-level declarations are globals.
// Canonical box shape: { x, y, w, h } in video-frame pixels.

function pointToPixel(point, frameWidth, frameHeight) {
  return {
    x: point.x <= 1 ? point.x * frameWidth : point.x,
    y: point.y <= 1 ? point.y * frameHeight : point.y,
  };
}

// Build the face box from the keypoint span alone. Blaze's six keypoints
// (eyes, nose tip, mouth, ear tragions) sit on the face even when the raw
// detector box drifts, so anchoring the region to them can never displace it.
// The span covers roughly ear-to-ear horizontally and brow-to-mouth
// vertically: the face extends ~one span above the eyes and ~a third below
// the mouth, hence the proportional expansion and the upward center shift.
function keypointFaceBox(keypoints, frameWidth, frameHeight) {
  const points = (keypoints || [])
    .map((point) => pointToPixel(point, frameWidth, frameHeight))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 4) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (keypointSpanDegenerate(keypoints, frameWidth, frameHeight)) return null;

  const w = Math.min(frameWidth, spanX * 1.18);
  const h = Math.min(frameHeight, spanY * 2.15);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2 - spanY * 0.3;
  return {
    x: Math.min(Math.max(0, cx - w / 2), Math.max(0, frameWidth - w)),
    y: Math.min(Math.max(0, cy - h / 2), Math.max(0, frameHeight - h)),
    w,
    h,
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

// True when the keypoint span is too small to describe a face — a degenerate
// read (e.g. a shoulder edge scored as a face) where landmark anchoring would
// land off any real face.
function keypointSpanDegenerate(keypoints, frameWidth, frameHeight) {
  const points = (keypoints || [])
    .map((point) => pointToPixel(point, frameWidth, frameHeight))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 4) return true;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return spanX < frameWidth * 0.04 || spanY < frameHeight * 0.04;
}

function calibratedFaceBox(box, keypoints, frameWidth, frameHeight) {
  // Prefer a purely keypoint-anchored box — the raw Blaze rect can sit off the
  // face, while the landmarks mark the features the gates actually need.
  const anchored = keypointFaceBox(keypoints, frameWidth, frameHeight);
  if (anchored) return anchored;
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
    keypointFaceBox,
    fitBoxToKeypoints,
    calibratedFaceBox,
    detectorBoxDisplaced,
    keypointSpanDegenerate,
    keypointSpanOutsideBox,
    pulseRoi,
  };
}
