'use strict';

function scaleYUV420(srcData, srcW, srcH, dstW, dstH) {
    if (srcW === dstW && srcH === dstH) {
        // No scaling needed — return as-is
        return Buffer.from(srcData);
    }

    const dstSize = (dstW * dstH * 3) >> 1;
    const dst = Buffer.alloc(dstSize);

    // Y plane: srcW×srcH → dstW×dstH
    const srcYEnd = srcW * srcH;
    const dstYEnd = dstW * dstH;
    for (let dy = 0; dy < dstH; dy++) {
        const sy = (dy * srcH / dstH) | 0;
        const srcRow = sy * srcW;
        const dstRow = dy * dstW;
        for (let dx = 0; dx < dstW; dx++) {
            dst[dstRow + dx] = srcData[srcRow + ((dx * srcW / dstW) | 0)];
        }
    }

    // U plane
    const srcUW = srcW >> 1, srcUH = srcH >> 1;
    const dstUW = dstW >> 1, dstUH = dstH >> 1;
    const srcUOff = srcYEnd;
    const dstUOff = dstYEnd;
    for (let dy = 0; dy < dstUH; dy++) {
        const sy = (dy * srcUH / dstUH) | 0;
        const srcRow = srcUOff + sy * srcUW;
        const dstRow = dstUOff + dy * dstUW;
        for (let dx = 0; dx < dstUW; dx++) {
            dst[dstRow + dx] = srcData[srcRow + ((dx * srcUW / dstUW) | 0)];
        }
    }

    // V plane
    const srcVOff = srcUOff + srcUW * srcUH;
    const dstVOff = dstUOff + dstUW * dstUH;
    for (let dy = 0; dy < dstUH; dy++) {
        const sy = (dy * srcUH / dstUH) | 0;
        const srcRow = srcVOff + sy * srcUW;
        const dstRow = dstVOff + dy * dstUW;
        for (let dx = 0; dx < dstUW; dx++) {
            dst[dstRow + dx] = srcData[srcRow + ((dx * srcUW / dstUW) | 0)];
        }
    }

    return dst;
}

module.exports = { scaleYUV420 };
