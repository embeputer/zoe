const assert = require('node:assert/strict');
const { pulseMetrics, flashMetrics } = require('./debug_metrics');

const pulse = [];
for (let index = 0; index < 100; index += 1) {
  const t = index * 100;
  pulse.push({ t, g: 120 + 0.8 * Math.sin((2 * Math.PI * 72 * t) / 60000) + 0.08 * Math.sin(index * 1.73) });
}
const pulseResult = pulseMetrics(pulse);
assert.equal(pulseResult.detected, true);
assert.ok(Math.abs(pulseResult.bpm - 72) <= 3, `expected about 72 BPM, got ${pulseResult.bpm}`);

const flatResult = pulseMetrics(Array.from({ length: 100 }, (_, index) => ({ t: index * 100, g: 120 })));
assert.equal(flatResult.detected, false);

const flashResult = flashMetrics(
  Array.from({ length: 10 }, () => [100, 100, 100]),
  Array.from({ length: 10 }, () => [145, 105, 105]),
  [255, 72, 72],
);
assert.ok(flashResult.cosine > 0.95);
assert.ok(flashResult.strength > 0);

console.log('camera debug metric tests passed');
