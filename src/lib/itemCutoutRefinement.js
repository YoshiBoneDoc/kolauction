// Remove white matte from the exterior edge only. Enclosed white artwork stays
// opaque; fractional edge coverage blends naturally into either page theme.
export function softenCutoutEdge({ data, width, height }) {
    const original = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        if (!original[p + 3]) continue;
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
            || original[p - 4 + 3] === 0 || original[p + 4 + 3] === 0
            || original[p - width * 4 + 3] === 0 || original[p + width * 4 + 3] === 0;
        if (!edge) continue;
        const coverage = 1 - Math.min(original[p], original[p + 1], original[p + 2]) / 255;
        if (coverage <= 0) { data[p + 3] = 0; continue; }
        for (let c = 0; c < 3; c++) data[p + c] = (original[p + c] - 255 * (1 - coverage)) / coverage;
        data[p + 3] = original[p + 3] * coverage;
    }
}

// A restrained unsharp pass on opaque interiors only. Never sharpen alpha or
// create new light/dark extrema: both can produce jagged outlines and halos.
export function sharpenCutoutInterior({ data, width, height }) {
    const original = new Uint8ClampedArray(data);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const p = (y * width + x) * 4;
        const neighbors = [p - 4, p + 4, p - width * 4, p + width * 4];
        if (original[p + 3] < 250 || neighbors.some(n => original[n + 3] < 250)) continue;
        for (let c = 0; c < 3; c++) {
            const center = original[p + c], values = neighbors.map(n => original[n + c]);
            const average = (4 * center + values.reduce((sum, value) => sum + value, 0)) / 8;
            data[p + c] = Math.max(Math.min(center, ...values), Math.min(Math.max(center, ...values), center + 0.45 * (center - average)));
        }
    }
}
