(function exposeDebugMetrics(root, factory) {
  const metrics = factory();
  if (typeof module === 'object' && module.exports) module.exports = metrics;
  if (root) root.ZoeDebugMetrics = metrics;
}(typeof window === 'object' ? window : null, () => {
  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function chromaticity(rgb) {
    const total = rgb[0] + rgb[1] + rgb[2];
    return total > 0 ? rgb.map((value) => value / total) : [0, 0, 0];
  }

  function pulseMetrics(samples) {
    if (!Array.isArray(samples) || samples.length < 40) {
      return { detected: false, reason: 'Collecting a longer sample' };
    }
    const spanMs = samples[samples.length - 1].t - samples[0].t;
    if (spanMs < 6000) return { detected: false, reason: 'Collecting a longer sample' };
    const values = samples.map((sample) => sample.g);
    const average = mean(values);
    const centered = values.map((value) => value - average);
    const std = Math.sqrt(mean(centered.map((value) => value * value)));
    const intervals = samples.slice(1).map((sample, index) => sample.t - samples[index].t).sort((a, b) => a - b);
    const sampleRate = 1000 / Math.max(1, intervals[Math.floor(intervals.length / 2)]);
    if (sampleRate < 4 || std < 0.08) {
      return { detected: false, reason: 'Signal is too flat', std, sampleRate };
    }

    const windowed = centered.map((value, index) => (
      value * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (centered.length - 1)))
    ));
    const binHz = 0.025;
    const lowBin = Math.ceil(0.5 / binHz);
    const highBin = Math.floor(3.2 / binHz);
    const pulseLowBin = Math.ceil(0.8 / binHz);
    const pulseHighBin = Math.floor(2.4 / binHz);
    const powers = new Float64Array(highBin + 1);
    let peakIndex = -1;
    let peakPower = 0;
    let bandPower = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      const angularFrequency = (2 * Math.PI * bin * binHz) / sampleRate;
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < windowed.length; index += 1) {
        real += windowed[index] * Math.cos(angularFrequency * index);
        imaginary -= windowed[index] * Math.sin(angularFrequency * index);
      }
      const power = real * real + imaginary * imaginary;
      powers[bin] = power;
      bandPower += power;
      if (bin >= pulseLowBin && bin <= pulseHighBin && power > peakPower) {
        peakIndex = bin;
        peakPower = power;
      }
    }
    if (peakIndex < 0 || bandPower <= 0) return { detected: false, reason: 'No pulse peak found' };
    const peakRatio = peakPower / (bandPower / (highBin - lowBin + 1));
    let lobePower = 0;
    for (let bin = peakIndex - 2; bin <= peakIndex + 2; bin += 1) lobePower += powers[bin] || 0;
    const lobeFraction = lobePower / bandPower;
    const quality = Math.max(0, Math.min(100, Math.round((peakRatio / 12) * 70 + lobeFraction * 30)));
    return {
      detected: peakRatio >= 3 && lobeFraction >= 0.08,
      bpm: Math.round(peakIndex * binHz * 60),
      quality,
      peakRatio,
      lobeFraction,
      std,
      sampleRate,
      reason: peakRatio >= 3 ? 'Pulse-shaped signal found' : 'No clear pulse peak yet',
    };
  }

  function flashMetrics(baselineSamples, flashSamples, expectedRgb) {
    if (!baselineSamples.length || !flashSamples.length) return null;
    const baseline = [0, 1, 2].map((channel) => mean(baselineSamples.map((sample) => sample[channel])));
    const observed = [0, 1, 2].map((channel) => mean(flashSamples.map((sample) => sample[channel])));
    const baselineChroma = chromaticity(baseline);
    const observedChroma = chromaticity(observed);
    const expectedChroma = chromaticity(expectedRgb);
    const delta = observedChroma.map((value, index) => value - baselineChroma[index]);
    const expectedDelta = expectedChroma.map((value) => value - (1 / 3));
    const deltaMagnitude = Math.hypot(...delta);
    const expectedMagnitude = Math.hypot(...expectedDelta);
    const cosine = deltaMagnitude > 1e-6 && expectedMagnitude > 1e-6
      ? delta.reduce((sum, value, index) => sum + value * expectedDelta[index], 0)
        / (deltaMagnitude * expectedMagnitude)
      : 0;
    return {
      cosine,
      strength: expectedMagnitude > 0 ? deltaMagnitude / expectedMagnitude : 0,
      baseline,
      observed,
    };
  }

  return { pulseMetrics, flashMetrics };
}));
