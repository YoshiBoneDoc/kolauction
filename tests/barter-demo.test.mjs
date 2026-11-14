import test from 'node:test';
import assert from 'node:assert/strict';
import { barterDemoReducer as reduce, createBarterDemo, latestDemoOffer } from '../src/lib/barterDemo.js';

const decide = (state, offerId, decision, extra = {}) => reduce(state, { type: 'decision', offerId, decision, ...extra });
test('host practice accepts lower-valued offers and the last acceptance wins, with immutable prior history', () => {
    const start = createBarterDemo('host');
    let state = decide(start, 'demo-items', 'accepted');
    assert.equal(state.currentOfferId, 'demo-items');
    assert.equal(state.offers.find(o => o.id === state.currentOfferId).value, 60_000_000);
    state = decide(state, 'demo-meat', 'accepted');
    assert.equal(state.currentOfferId, 'demo-meat');
    assert.equal(state.offers.filter(o => o.status === 'accepted').length, 3);
    assert.equal(decide(state, 'demo-items', 'rejected'), state);
    state = reduce(state, { type: 'end' });
    assert.equal(state.currentOfferId, 'demo-meat');
    assert.equal(state.offers.find(o => o.id === 'demo-mixed').status, 'expired');
    assert.equal(decide(state, 'demo-mixed', 'accepted'), state);
    assert.equal(start.offers.find(o => o.id === 'demo-meat').status, 'pending');
});
test('host feedback leads to a new revised offer without rewriting its original quantities', () => {
    let state = decide(createBarterDemo('host'), 'demo-items', 'changes_requested', { rejectedItems: [10881], raiseRequested: true });
    const source = state.offers.find(o => o.id === 'demo-items');
    state = reduce(state, { type: 'revised-response', offerId: source.id });
    const revised = state.offers.at(-1);
    assert.equal(revised.status, 'pending');
    assert.equal(revised.bidderLabel, source.bidderLabel);
    assert.ok(revised.value > source.value);
    assert.ok(!revised.items.some(item => item.id === 10881));
    assert.equal(state.offers.find(o => o.id === source.id).items.length, 5);
    assert.equal(reduce(state, { type: 'revised-response', offerId: source.id }), state);
    assert.equal(state.currentOfferId, 'demo-leading');
});
test('bidder revision copies an offer; only one pending offer is allowed, withdrawal permits resubmission', () => {
    let state = createBarterDemo('bidder');
    state = reduce(state, { type: 'revise', offerId: 'demo-own' });
    assert.deepEqual(state.draftOffer.items.map(i => i.id), [194, 10881, 258, 9564, 938]);
    state = reduce(state, { type: 'submit', meat: 80_000_000, items: [] });
    const pending = latestDemoOffer(state);
    assert.equal(pending.status, 'pending');
    assert.equal(state.currentOfferId, 'demo-leading');
    assert.equal(reduce(state, { type: 'submit', meat: 100, items: [] }), state);
    state = decide(state, pending.id, 'withdrawn');
    state = reduce(state, { type: 'submit', meat: 90_000_000, items: [] });
    assert.equal(latestDemoOffer(state).meat, 90_000_000);
});
test('bidder rejection, change requests, acceptance and replacement have distinct outcomes', () => {
    for (const decision of ['rejected', 'changes_requested', 'accepted']) {
        let state = createBarterDemo('bidder', 'pending');
        state = decide(state, 'demo-own', decision, { raiseRequested: true });
        assert.equal(latestDemoOffer(state).status, decision);
        assert.equal(state.currentOfferId, decision === 'accepted' ? 'demo-own' : 'demo-leading');
        if (decision === 'accepted') {
            state = reduce(state, { type: 'replace' });
            assert.notEqual(state.currentOfferId, 'demo-own');
            assert.equal(latestDemoOffer(state).status, 'accepted');
            assert.equal(state.offers.at(-1).value, 25_000_000);
        }
    }
});
test('every bidder example has consistent accepted history, and reset/end preserve demo boundaries', () => {
    for (const scenario of ['pending', 'accepted', 'rejected', 'changes_requested', 'superseded']) {
        const state = createBarterDemo('bidder', scenario);
        const accepted = state.offers.filter(o => o.status === 'accepted').sort((a, b) => b.acceptedOrder - a.acceptedOrder);
        assert.equal(accepted[0].id, state.currentOfferId);
        const closed = reduce(state, { type: 'end' });
        assert.equal(closed.ended, true);
        assert.ok(!closed.offers.some(o => ['pending', 'changes_requested'].includes(o.status)));
        assert.equal(reduce(closed, { type: 'submit', meat: 100, items: [] }), closed);
        const reset = reduce(closed, { type: 'reset' });
        assert.equal(reset.ended, false);
        assert.equal(reset.offers.length, 2);
        assert.equal(reset.formVersion, 1);
    }
});
