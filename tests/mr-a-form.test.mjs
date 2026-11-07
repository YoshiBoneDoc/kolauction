import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';

const require = createRequire(import.meta.url);
const built = buildSync({ entryPoints: ['src/components/MixedBidForm.jsx'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', jsx: 'automatic', define: { 'import.meta.env': '{}' } });
let slots, cursor, offers, prompt, failure;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? {
    ...React, useId: () => 'test-payment',
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
    useContext: () => ({ placeBid: async (...args) => { offers.push(args); if (failure) throw new Error(failure); } }),
} : require(name), compiled, compiled.exports);
const auction = { id: 'id', item: 'seal tooth', quantity: 1, mrARate: 70_000_000, minBidMeat: 1, currentBid: 0, instantPurchasePrice: 150_000_000 };
const render = (overrides = {}) => { cursor = 0; return compiled.exports.default({ auction: { ...auction, ...overrides } }); };
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)] : [];
function reset() { slots = []; cursor = 0; offers = []; prompt = ''; failure = null; globalThis.window = { confirm: text => { prompt = text; return true; } }; }
function enter(meat, quantity) {
    const inputs = nodes(render()).filter(node => node.type === 'input');
    inputs[0].props.onChange({ target: { value: meat } });
    inputs[1].props.onChange({ target: { value: quantity } });
}
test('mixed form confirms exact composition and excludes excess Meat at buyout', async () => {
    reset(); enter('20m', '2');
    await render().props.onSubmit({ preventDefault() {} });
    assert.match(prompt, /2 Mr. A's \+ 10,000,000 Meat/);
    assert.match(prompt, /accepts the buyout/);
    assert.deepEqual(offers, [['id', 150_000_000, { meat: 10_000_000, mrAQuantity: 2, value: 150_000_000, refundMeat: 10_000_000 }]]);
});
test('all-Mr. A bids accept zero Meat and preserve integer quantity', async () => {
    reset(); enter('', '1');
    await render().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(offers, [['id', 70_000_000, { meat: 0, mrAQuantity: 1, value: 70_000_000 }]]);
});
test('impossible buyout and fractional quantities do not submit', async () => {
    reset(); enter('0', '3');
    await render().props.onSubmit({ preventDefault() {} });
    assert.equal(offers.length, 0);
    assert.match(slots[3], /exceeds the buyout/);
    enter('0', '1.5');
    await render().props.onSubmit({ preventDefault() {} });
    assert.equal(offers.length, 0);
});
test('uncertain write is surfaced without automatic retry', async () => {
    reset(); enter('6m', '1'); failure = 'Outcome uncertain';
    await render().props.onSubmit({ preventDefault() {} });
    assert.equal(offers.length, 1);
    assert.equal(slots[3], 'Outcome uncertain');
    assert.equal(slots[0], '6m');
});
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
    : React.Children.toArray(tree?.props?.children).map(text).join('');
test('live value updates below the minimum and shows full entered value above buyout', () => {
    reset();
    assert.match(text(render()), /Bid value: 0 Meat/);
    enter('6m', '1');
    const underMinimum = text(render({ minBidMeat: 100_000_000 }));
    assert.match(underMinimum, /Bid value: 76,000,000 Meat/);
    assert.match(underMinimum, /Next minimum bid: 100,000,000 Meat/);
    enter('20m', '2');
    assert.match(text(render()), /Bid value: 160,000,000 Meat/);
    assert.match(text(render()), /Payment: 2 Mr. A's \+ 10,000,000 Meat \(150,000,000 Meat value\)/);
    enter('0', '1.5');
    assert.match(text(render()), /Enter valid amounts/);
});
test('Mr. A quantity arrows step whole items, update value, and stop at zero', () => {
    reset();
    const arrow = direction => nodes(render()).find(node => node.props?.['aria-label'] === `${direction} Mr. A quantity`);
    arrow('Increase').props.onClick();
    assert.equal(slots[1], '1');
    assert.match(text(render()), /Bid value: 70,000,000 Meat/);
    arrow('Decrease').props.onClick();
    arrow('Decrease').props.onClick();
    assert.equal(slots[1], '0');
});
