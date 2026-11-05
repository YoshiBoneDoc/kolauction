import test from 'node:test';
import assert from 'node:assert/strict';
import { rafflePrizePositions, raffleBoxCenter } from '../src/lib/rafflePrizeCurve.js';
test('all pool sizes share the same path and preserve order', () => {
    assert.deepEqual(rafflePrizePositions(0), []);
    for (const count of [2, 3, 4, 6, 20]) {
        const points = rafflePrizePositions(count);
        if (count > 3) {
            assert.deepEqual(points[0], { x: 5, y: 5 });
            assert.deepEqual(points.at(-1), { x: 29, y: 89 });
        } else {
            assert.ok(points[0].y > 5);
            assert.ok(points.at(-1).y < 89);
        }
        for (let i = 1; i < points.length; i++) assert.ok(points[i].y > points[i - 1].y);
    }
    const [single] = rafflePrizePositions(1);
    assert.ok(single.y > 5 && single.y < 89);
});
test('spacing follows distance along the curve at actual display proportions', () => {
    for (const [width, height] of [[500, 326], [350, 1800]]) {
        const points = rafflePrizePositions(20, width, height);
        const gaps = points.slice(1).map((point, i) => Math.hypot((point.x - points[i].x) * width / 100, (point.y - points[i].y) * height / 100));
        assert.ok(Math.max(...gaps) / Math.min(...gaps) < 1.05);
    }
});

test('box translation balances distance to the three icons without altering their curve', () => {
    for (const [width,height] of [[400,326],[500,326]]) {
        const points=rafflePrizePositions(3,width,height);
        const original=structuredClone(points);
        const center=raffleBoxCenter(points,width,height);
        const distances=points.map(p=>Math.hypot(p.x*width/100-center.x,p.y*height/100-center.y));
        assert.ok(Math.max(...distances)-Math.min(...distances)<0.001);
        assert.deepEqual(points,original);
    }
    assert.equal(raffleBoxCenter([],500,326),null);
    assert.equal(raffleBoxCenter([{x:0,y:0},{x:1,y:1},{x:2,y:2}],500,326),null);
});
