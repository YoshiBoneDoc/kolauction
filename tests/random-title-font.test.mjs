import test from 'node:test';
import assert from 'node:assert/strict';
import { titleFontShortlist, randomFamily, fontPollActive, fontCatalog, activeFontPoll } from '../src/lib/randomTitleFont.js';

test('shortlist contains the suggestions, current title and all ten hearted finalists', async () => {
    assert.equal(titleFontShortlist.length, 13);
    assert.equal(new Set(titleFontShortlist).size, 13);
    for (const name of ['Newsreader', 'Comic Sans MS', 'Stack Sans Text', 'Jersey 25 Charted', 'Mynerve']) {
        assert.ok(titleFontShortlist.includes(name));
    }
    assert.ok(!titleFontShortlist.includes('Wingdings'));
    assert.equal(await fontCatalog(), titleFontShortlist);
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
test('shortlist needs no external catalog request', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Unexpected catalog request'); };
    try { assert.deepEqual(await fontCatalog(), titleFontShortlist); }
    finally { globalThis.fetch = original; }
});

test('dedicated shortlist round takes priority over other active font polls', () => {
    const original = {id:'original',active:true,question:'What font do you prefer?'};
    const shortlist = {id:'shortlist',active:true,question:'Which shortlisted fonts do you prefer?'};
    assert.equal(activeFontPoll({poll:original,font_poll:shortlist}).id,'shortlist');
    assert.equal(activeFontPoll({poll:original,font_poll:{...shortlist,active:false}}).id,'original');
});
