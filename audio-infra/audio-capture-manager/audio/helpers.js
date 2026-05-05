'use strict';

function int16ArrayToBuffer(samples) {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function downmixToMonoInt16(samples, channelCount) {
    if (!samples || channelCount <= 1) {
        return samples;
    }

    const frameCount = Math.floor(samples.length / channelCount);
    const mono = new Int16Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        let sum = 0;
        const base = frameIndex * channelCount;
        for (let channel = 0; channel < channelCount; channel++) {
            sum += samples[base + channel];
        }
        mono[frameIndex] = Math.max(-32768, Math.min(32767, Math.round(sum / channelCount)));
    }

    return mono;
}

function resampleMonoInt16Nearest(samples, srcRate, dstRate) {
    if (!samples || srcRate === dstRate || samples.length === 0) {
        return samples;
    }

    const outLength = Math.max(1, Math.round(samples.length * dstRate / srcRate));
    const out = new Int16Array(outLength);

    for (let i = 0; i < outLength; i++) {
        const srcIndex = Math.min(samples.length - 1, Math.round(i * srcRate / dstRate));
        out[i] = samples[srcIndex];
    }

    return out;
}

module.exports = { int16ArrayToBuffer, downmixToMonoInt16, resampleMonoInt16Nearest };
