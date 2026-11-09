import test from 'node:test';
import assert from 'node:assert/strict';
import { googleFontFamilies, randomFamily, fontPollActive, fontCatalog } from '../src/lib/randomTitleFont.js';

test('catalog includes all eligible Google families and excludes non-Latin and non-Google entries', () => {
    const row = { family: 'Example', type: 'google', subsets: ['latin'], styles: ['normal'] };
    assert.deepEqual(googleFontFamilies([row, row, { ...row, family: 'Other' }, { ...row, type: 'other' }, { ...row, subsets: ['arabic'] }]), ['Example', 'Other']);
});
test('random selection never repeats the current family', () => {
    assert.equal(randomFamily(['A', 'B'], 'A', () => 0), 'B');
    assert.equal(randomFamily(['A'], 'A'), null);
});
test('only active font polls enable previews, including answered and skipped polls', () => {
    const poll = { active: true, question: 'Which font for the title?' };
    for (const key of ['answered_polls', 'repeatable_polls', 'skipped_polls']) assert.equal(fontPollActive({ [key]: [poll] }), true);
    assert.equal(fontPollActive({ poll }), true);
    assert.equal(fontPollActive({ poll: { ...poll, active: false } }), false);
    assert.equal(fontPollActive({ poll: { active: true, question: 'Auction fees?' } }), false);
    assert.equal(fontPollActive(null), false);
});
test('catalog is fetched lazily and coalesced in browser memory', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => [{ family: 'Example', type: 'google', subsets: ['latin'], styles: ['normal'] }] }; };
    try {
        const [a, b] = await Promise.all([fontCatalog(), fontCatalog()]);
        assert.equal(calls, 1); assert.deepEqual(a, ['Example']); assert.deepEqual(b, a);
    } finally { globalThis.fetch = original; }
});
