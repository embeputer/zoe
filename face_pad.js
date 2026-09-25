const crypto = require('crypto');
const path = require('path');
const jpeg = require('jpeg-js');
const ort = require('onnxruntime-node');

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const MODEL_SIZE = 128;
const MIN_FRAMES = 3;
const MAX_FRAMES = 5;
const MAX_FRAME_BYTES = 90 * 1024;
const MAX_TOTAL_FRAME_BYTES = 400 * 1024;
const MIN_FRAME_GAP_MS = 300;
const MIN_FRAME_SPAN_MS = 1200;
const MIN_FACE_SOURCE_PX = 64;
const REAL_LOGIT_THRESHOLD = 0.5;
const REQUIRED_REAL_RUN = 3;
const DETECTOR_SIZE = 640;
const DETECTOR_CONFIDENCE_MIN = 0.8;
const DETECTOR_MATCH_IOU_MIN = 0.03;
const MODEL_PATH = process.env.ZOE_FACE_PAD_MODEL
  || path.join(__dirname, 'models', 'face_antispoof_quantized.onnx');
const DETECTOR_PATH = process.env.ZOE_FACE_DETECTOR_MODEL
  || path.join(__dirname, 'models', 'face_detector.onnx');

let sessionPromise = null;
let detectorSessionPromise = null;

function computePresentationDigest(challengeId, mediaFrames) {
  return crypto
    .createHash('sha256')
    .update(`${challengeId}\n${JSON.stringify(mediaFrames)}`)
    .digest('hex');
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function validateFaceBox(face) {
  if (!Array.isArray(face) || face.length !== 4) return false;
  if (!face.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
  const [x, y, width, height] = face;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return false;
  if (width > 0.85 || height > 0.95) return false;
  return width * FRAME_WIDTH >= MIN_FACE_SOURCE_PX && height * FRAME_HEIGHT >= MIN_FACE_SOURCE_PX;
}

function validatePresentationFrames(challengeId, mediaFrames, mediaDigest) {
  if (!Array.isArray(mediaFrames) || mediaFrames.length < MIN_FRAMES || mediaFrames.length > MAX_FRAMES) {
    return { error: 'Camera media sample count is invalid.' };
  }
  if (!/^[a-f0-9]{64}$/.test(mediaDigest || '')) {
    return { error: 'Camera media digest is invalid.' };
  }
  if (computePresentationDigest(challengeId, mediaFrames) !== mediaDigest) {
    return { error: 'Camera media is not bound to this challenge.' };
  }

  const decodedFrames = [];
  const imageDigests = new Set();
  let previousT = -1;
  let totalBytes = 0;
  for (const frame of mediaFrames) {
    const t = Number(frame && frame.t);
    if (!Number.isFinite(t) || t < 0 || t > 30000 || t <= previousT) {
      return { error: 'Camera media timing is invalid.' };
    }
    if (previousT >= 0 && t - previousT < MIN_FRAME_GAP_MS) {
      return { error: 'Camera media frames are too close together.' };
    }
    previousT = t;
    if (!validateFaceBox(frame.face)) return { error: 'Camera media face box is invalid.' };
    if (typeof frame.image !== 'string' || frame.image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.image)) {
      return { error: 'Camera media frame is invalid.' };
    }

    const bytes = Buffer.from(frame.image, 'base64');
    totalBytes += bytes.length;
    if (bytes.length < 1024 || bytes.length > MAX_FRAME_BYTES || totalBytes > MAX_TOTAL_FRAME_BYTES) {
      return { error: 'Camera media frame size is invalid.' };
    }
    const dimensions = jpegDimensions(bytes);
    if (!dimensions || dimensions.width !== FRAME_WIDTH || dimensions.height !== FRAME_HEIGHT) {
      return { error: 'Camera media frame dimensions are invalid.' };
    }
    imageDigests.add(crypto.createHash('sha256').update(bytes).digest('hex'));
    let image;
    try {
      image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    } catch {
      return { error: 'Camera media frame could not be decoded.' };
    }
    if (image.width !== FRAME_WIDTH || image.height !== FRAME_HEIGHT || image.data.length !== FRAME_WIDTH * FRAME_HEIGHT * 4) {
      return { error: 'Camera media frame decoded incorrectly.' };
    }
    decodedFrames.push({ t, face: frame.face, image });
  }

  if (decodedFrames[decodedFrames.length - 1].t - decodedFrames[0].t < MIN_FRAME_SPAN_MS) {
    return { error: 'Camera media capture was too short.' };
  }
  if (imageDigests.size < MIN_FRAMES) return { error: 'Camera media repeated the same frame.' };
  return { frames: decodedFrames };
}

function reflectedIndex(value, size) {
  let result = value;
  while (result < 0 || result >= size) {
    if (result < 0) result = -result;
    if (result >= size) result = (2 * size) - result - 2;
  }
  return result;
}

function sampleChannel(image, x, y, channel) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const dx = x - x0;
  const dy = y - y0;
  const at = (px, py) => {
    const rx = reflectedIndex(px, image.width);
    const ry = reflectedIndex(py, image.height);
    return image.data[((ry * image.width + rx) * 4) + channel];
  };
  const top = at(x0, y0) * (1 - dx) + at(x1, y0) * dx;
  const bottom = at(x0, y1) * (1 - dx) + at(x1, y1) * dx;
  return (top * (1 - dy) + bottom * dy) / 255;
}

function preprocessFrame(frame, output, batchIndex, face = frame.face) {
  const [nx, ny, nw, nh] = face;
  const x = nx * frame.image.width;
  const y = ny * frame.image.height;
  const width = nw * frame.image.width;
  const height = nh * frame.image.height;
  const cropSize = Math.max(width, height) * 1.5;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const startX = centerX - cropSize / 2;
  const startY = centerY - cropSize / 2;
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const batchOffset = batchIndex * 3 * planeSize;

  for (let oy = 0; oy < MODEL_SIZE; oy += 1) {
    const sy = startY + ((oy + 0.5) / MODEL_SIZE) * cropSize - 0.5;
    for (let ox = 0; ox < MODEL_SIZE; ox += 1) {
      const sx = startX + ((ox + 0.5) / MODEL_SIZE) * cropSize - 0.5;
      const pixelIndex = oy * MODEL_SIZE + ox;
      output[batchOffset + pixelIndex] = sampleChannel(frame.image, sx, sy, 0);
      output[batchOffset + planeSize + pixelIndex] = sampleChannel(frame.image, sx, sy, 1);
      output[batchOffset + 2 * planeSize + pixelIndex] = sampleChannel(frame.image, sx, sy, 2);
    }
  }
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
}

function getDetectorSession() {
  if (!detectorSessionPromise) {
    detectorSessionPromise = ort.InferenceSession.create(DETECTOR_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  return detectorSessionPromise;
}

function detectorInput(image) {
  const planeSize = DETECTOR_SIZE * DETECTOR_SIZE;
  const input = new Float32Array(3 * planeSize);
  for (let y = 0; y < DETECTOR_SIZE; y += 1) {
    const sy = ((y + 0.5) / DETECTOR_SIZE) * image.height - 0.5;
    for (let x = 0; x < DETECTOR_SIZE; x += 1) {
      const sx = ((x + 0.5) / DETECTOR_SIZE) * image.width - 0.5;
      const offset = y * DETECTOR_SIZE + x;
      input[offset] = sampleChannel(image, sx, sy, 2) * 255 - 104;
      input[planeSize + offset] = sampleChannel(image, sx, sy, 1) * 255 - 117;
      input[2 * planeSize + offset] = sampleChannel(image, sx, sy, 0) * 255 - 123;
    }
  }
  return new ort.Tensor('float32', input, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]);
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectorBoxes(outputs) {
  const boxes = [];
  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const columns = DETECTOR_SIZE / stride;
    for (let index = 0; index < cls.length; index += 1) {
      const confidence = Math.sqrt(Math.max(0, Number(cls[index]) * Number(obj[index])));
      if (confidence < DETECTOR_CONFIDENCE_MIN) continue;
      const row = Math.floor(index / columns);
      const column = index % columns;
      // YuNet predicts the box CENTER at cell + offset (per OpenCV's
      // face_detect.cpp reference decoder), not the top-left corner.
      const width = Math.exp(Number(bbox[index * 4 + 2])) * stride;
      const height = Math.exp(Number(bbox[index * 4 + 3])) * stride;
      const x = (column + Number(bbox[index * 4])) * stride - width / 2;
      const y = (row + Number(bbox[index * 4 + 1])) * stride - height / 2;
      if (![x, y, width, height].every(Number.isFinite)) continue;
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      const right = Math.min(DETECTOR_SIZE, x + width);
      const bottom = Math.min(DETECTOR_SIZE, y + height);
      const clippedWidth = right - left;
      const clippedHeight = bottom - top;
      if (
        clippedWidth >= MIN_FACE_SOURCE_PX * 2
        && clippedHeight >= MIN_FACE_SOURCE_PX * (DETECTOR_SIZE / FRAME_HEIGHT)
      ) {
        boxes.push({
          x: left,
          y: top,
          width: clippedWidth,
          height: clippedHeight,
          confidence,
        });
      }
    }
  }
  return boxes;
}

async function serverDetectsClaimedFace(frame) {
  const session = await getDetectorSession();
  const outputs = await session.run({ [session.inputNames[0]]: detectorInput(frame.image) });
  const [x, y, width, height] = frame.face;
  const claimed = {
    x: x * DETECTOR_SIZE,
    y: y * DETECTOR_SIZE,
    width: width * DETECTOR_SIZE,
    height: height * DETECTOR_SIZE,
  };
  const matches = detectorBoxes(outputs).filter((box) => {
    const claimedCenterX = claimed.x + claimed.width / 2;
    const claimedCenterY = claimed.y + claimed.height / 2;
    const detectedCenterX = box.x + box.width / 2;
    const detectedCenterY = box.y + box.height / 2;
    const centerDistance = Math.hypot(
      detectedCenterX - claimedCenterX,
      detectedCenterY - claimedCenterY
    );
    return (
      intersectionOverUnion(box, claimed) >= DETECTOR_MATCH_IOU_MIN
      && centerDistance <= Math.max(claimed.width, claimed.height) * 1.25
    );
  });
  matches.sort((a, b) => b.confidence - a.confidence);
  const match = matches[0];
  if (!match) return null;
  return [
    match.x / DETECTOR_SIZE,
    match.y / DETECTOR_SIZE,
    match.width / DETECTOR_SIZE,
    match.height / DETECTOR_SIZE,
  ];
}

async function analyzePresentationFrames(frames) {
  const [session, detectedFaceBoxes] = await Promise.all([
    getSession(),
    Promise.all(frames.map((frame) => serverDetectsClaimedFace(frame))),
  ]);
  let currentFaceRun = 0;
  let longestFaceRun = 0;
  for (const detectedFaceBox of detectedFaceBoxes) {
    currentFaceRun = detectedFaceBox ? currentFaceRun + 1 : 0;
    longestFaceRun = Math.max(longestFaceRun, currentFaceRun);
  }
  if (longestFaceRun < REQUIRED_REAL_RUN) {
    return {
      real: false,
      medianScore: Number.NEGATIVE_INFINITY,
      longestRealRun: 0,
      longestFaceRun,
    };
  }
  const input = new Float32Array(frames.length * 3 * MODEL_SIZE * MODEL_SIZE);
  frames.forEach((frame, index) => {
    preprocessFrame(frame, input, index, detectedFaceBoxes[index] || frame.face);
  });
  const tensor = new ort.Tensor('float32', input, [frames.length, 3, MODEL_SIZE, MODEL_SIZE]);
  const outputs = await session.run({ [session.inputNames[0]]: tensor });
  const logits = outputs[session.outputNames[0]];
  if (!logits || logits.dims[0] !== frames.length || logits.dims[1] !== 2) {
    throw new Error('Face PAD model returned an invalid output shape.');
  }

  const scores = [];
  let currentRun = 0;
  let longestRun = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const score = Number(logits.data[i * 2]) - Number(logits.data[i * 2 + 1]);
    scores.push(score);
    currentRun = score >= REAL_LOGIT_THRESHOLD ? currentRun + 1 : 0;
    longestRun = Math.max(longestRun, currentRun);
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const medianScore = sorted[Math.floor(sorted.length / 2)];
  return {
    real: longestFaceRun >= REQUIRED_REAL_RUN && longestRun >= REQUIRED_REAL_RUN && medianScore >= REAL_LOGIT_THRESHOLD,
    medianScore,
    longestRealRun: longestRun,
    longestFaceRun,
  };
}

module.exports = {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  computePresentationDigest,
  validatePresentationFrames,
  analyzePresentationFrames,
};
