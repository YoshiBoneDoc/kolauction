import test from 'node:test';
import assert from 'node:assert/strict';
import { softenCutoutEdge, sharpenCutoutInterior } from '../src/lib/itemCutoutRefinement.js';
const picture = (size, color) => ({ width: size, height: size, data: new Uint8ClampedArray(Array.from({ length: size * size }, () => color).flat()) });
const set = (image, x, y, color) => image.data.set(color, (y * image.width + x) * 4);
const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
test('exterior white matte becomes fractional coverage, without washing out enclosed whites', () => {
    const image = picture(5, [0, 0, 0, 0]);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) set(image, x, y, [128, 128, 128, 255]);
    set(image, 2, 2, [255, 255, 255, 255]);
    softenCutoutEdge(image);
    assert.deepEqual(pixel(image, 1, 1), [0, 0, 0, 127]);
    assert.deepEqual(pixel(image, 2, 2), [255, 255, 255, 255]);
    assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 0]);
});
test('edge correction preserves solid color and black ink', () => {
    const image = picture(3, [0, 0, 0, 0]);
    set(image, 1, 0, [255, 0, 0, 255]);
    set(image, 0, 1, [0, 0, 0, 255]);
    softenCutoutEdge(image);
    assert.deepEqual(pixel(image, 1, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(image, 0, 1), [0, 0, 0, 255]);
});
test('light interior sharpening clarifies transitions without changing edge alpha', () => {
    const image = picture(5, [160, 160, 160, 255]);
    set(image, 2, 2, [80, 80, 80, 255]);
    set(image, 1, 2, [0, 0, 0, 255]);
    set(image, 0, 0, [0, 0, 0, 90]);
    const alpha = [...image.data].filter((_, index) => index % 4 === 3);
    sharpenCutoutInterior(image);
    assert.ok(pixel(image, 2, 2)[0] < 80 && pixel(image, 2, 2)[0] > 0);
    assert.deepEqual([...image.data].filter((_, index) => index % 4 === 3), alpha);
    assert.deepEqual(pixel(image, 0, 0), [0, 0, 0, 90]);
});
test('partially transparent outlines are excluded from sharpening', () => {
    const image = picture(3, [255, 255, 255, 255]);
    set(image, 1, 1, [30, 30, 30, 120]);
    const original = [...image.data];
    sharpenCutoutInterior(image);
    assert.deepEqual([...image.data], original);
});
