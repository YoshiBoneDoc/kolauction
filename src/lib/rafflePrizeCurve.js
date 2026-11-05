// The four marked positions, relative to the prize display area.
const anchors = [[5, 5], [23, 25], [34, 59], [29, 89]];
export function rafflePrizePositions(count, width = 500, height = 326) {
    if (!count) return [];
    const samples = [];
    let length = 0;
    for (let segment = 0; segment < anchors.length - 1; segment++) {
        const [a, b, c, d] = [anchors[Math.max(0, segment - 1)], anchors[segment], anchors[segment + 1], anchors[Math.min(anchors.length - 1, segment + 2)]];
        for (let step = segment ? 1 : 0; step <= 60; step++) {
            const t = step / 60;
            const point = [0, 1].map(axis => 0.5 * (2 * b[axis] + (-a[axis] + c[axis]) * t + (2 * a[axis] - 5 * b[axis] + 4 * c[axis] - d[axis]) * t * t + (-a[axis] + 3 * b[axis] - 3 * c[axis] + d[axis]) * t * t * t));
            const last = samples.at(-1);
            if (last) length += Math.hypot((point[0] - last.x) * width / 100, (point[1] - last.y) * height / 100);
            samples.push({ x: point[0], y: point[1], length });
        }
    }
    return Array.from({ length: count }, (_, index) => {
        // Keep the complete outward-and-back shape, compressing its vertical
        // span for smaller pools instead of dropping either end of the curve.
        const target = length * (count === 1 ? 0.5 : index / (count - 1));
        const end = samples.findIndex(p => p.length >= target);
        const right = samples[end], left = samples[Math.max(0, end - 1)];
        const t = right.length === left.length ? 0 : (target - left.length) / (right.length - left.length);
        const y = left.y + (right.y - left.y) * t;
        const scale = count === 2 ? 0.68 : count === 3 ? 0.8 : 1;
        return { x: left.x + (right.x - left.x) * t, y: count === 1 ? y : 47 + (y - 47) * scale };
    });
}

// Locate the box at the center of the circle through the three displayed icons.
// This moves only the box; the chosen curve and prize spacing stay unchanged.
export function raffleBoxCenter(points, width, height) {
    if (points.length !== 3) return null;
    const [a, b, c] = points.map(p => ({ x: p.x * width / 100, y: p.y * height / 100 }));
    const denominator = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(denominator) < 0.001) return null;
    const square = p => p.x * p.x + p.y * p.y;
    return {
        x: (square(a) * (b.y - c.y) + square(b) * (c.y - a.y) + square(c) * (a.y - b.y)) / denominator,
        y: (square(a) * (c.x - b.x) + square(b) * (a.x - c.x) + square(c) * (b.x - a.x)) / denominator,
    };
}
