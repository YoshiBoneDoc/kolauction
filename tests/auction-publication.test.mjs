import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as router from 'react-router-dom';

// Drive the real page's handlers with a small hook harness; no live API or DOM.
const { outputFiles } = buildSync({ stdin: { contents: `
    export { default as AuctionAnItem } from './src/pages/AuctionAnItem.jsx';
    export { UserContext } from './src/context/UserContext.jsx';
    export { AuctionsContext } from './src/context/AuctionsContext.jsx';
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' }, loader: { '.gif': 'dataurl' },
});
let active;
function slot(initial) {
    const harness = active;
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [harness.slots[index], value => { harness.slots[index] = typeof value === 'function' ? value(harness.slots[index]) : value; }];
}
const hooks = { ...React, useState: slot, useRef: value => slot({ current: value })[0],
    useContext: context => active.contexts.get(context), useEffect() {}, useMemo: fn => fn(), useDeferredValue: value => value };
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? hooks
    : name === 'react-router-dom' ? { ...router, useNavigate: () => active.navigate } : requireModule(name), compiled, compiled.exports);
const { AuctionAnItem, UserContext, AuctionsContext } = compiled.exports;
function nodes(element) {
    if (!element || typeof element !== 'object') return [];
    return [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
}
function harness(addAuction) {
    const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    const result = { slots: [], cursor: 0, contexts: new Map([[UserContext, { currentUser: { id: 'seller' } }], [AuctionsContext, { addAuction }]]),
        locations: [], dialog, navigate(path) { result.locations.push(path); },
        render() {
            active = result; result.cursor = 0;
            result.tree = AuctionAnItem();
            const element = nodes(result.tree).find(node => node.type === 'dialog');
            if (element) element.ref.current = dialog;
            return result;
        },
        find(predicate) { const found = nodes(result.tree).find(predicate); assert.ok(found, 'Expected page element'); return found; },
        input(id, value) { result.find(node => node.props?.id === id).props.onChange({ target: { value } }); return result.render(); },
        button(label) { return result.find(node => node.type === 'button' && node.props.children === label); },
        preview(escrow, { quantity = '1', minimum = '100', buyout = '', duration = '24' } = {}) {
            result.render();
            result.button(escrow ? 'Escrow' : 'Direct').props.onClick(); result.render();
            result.input('listing-item-search', 'asbestos ore').input('item', '364').input('quantity', quantity).input('minBidMeat', minimum).input('auctionTime', duration);
            if (buyout) {
                const original = globalThis.requestAnimationFrame;
                globalThis.requestAnimationFrame = callback => callback();
                try { result.button('Set Buyout Price (optional)').props.onClick(); }
                finally { if (original) globalThis.requestAnimationFrame = original; else delete globalThis.requestAnimationFrame; }
                result.render();
                result.input('instantPurchasePrice', buyout);
            }
            const originalFrame = globalThis.requestAnimationFrame;
            globalThis.requestAnimationFrame = callback => callback();
            try { result.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); }
            finally { if (originalFrame) globalThis.requestAnimationFrame = originalFrame; else delete globalThis.requestAnimationFrame; }
            return result.render();
        },
    };
    return result;
}

test('both trading methods require the shared popup before any auction write', async () => {
    for (const escrow of [true, false]) {
        const writes = [];
        const page = harness(async listing => { writes.push(listing); return 'new-auction'; }).preview(escrow);
        assert.equal(writes.length, 0);
        page.button('Continue to Publish').props.onClick(); page.render();
        assert.equal(page.dialog.open, true);
        assert.equal(writes.length, 0);
        assert.match(nodes(page.tree).map(node => typeof node.props?.children === 'string' ? node.props.children : '').join(' '), /Please review the following before publishing your auction/);
        page.button('Cancel').props.onClick();
        assert.equal(page.dialog.open, false);
        assert.equal(writes.length, 0);
        page.button('Continue to Publish').props.onClick(); page.render();
        await page.button('Publish Auction').props.onClick();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].escrowMode, escrow);
        assert.equal(page.dialog.open, false);
        assert.deepEqual(page.locations, ['/auction/new-auction']);
    }
});

test('publishing blocks duplicate clicks and Escape until the save finishes', async () => {
    let finish;
    let writes = 0;
    const page = harness(() => { writes++; return new Promise(resolve => { finish = resolve; }); }).preview(false);
    page.button('Continue to Publish').props.onClick(); page.render();
    const publish = page.button('Publish Auction').props.onClick;
    const saving = publish();
    await publish();
    page.render();
    assert.equal(writes, 1);
    assert.equal(page.button('Publishing…').props.disabled, true);
    assert.equal(page.button('Cancel').props.disabled, true);
    let prevented = false;
    page.find(node => node.type === 'dialog').props.onCancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    finish('saved-auction'); await saving;
    assert.deepEqual(page.locations, ['/auction/saved-auction']);
});

test('failed publication leaves the popup open with the error and permits a retry', async () => {
    let attempts = 0;
    const page = harness(async () => { if (++attempts === 1) throw new Error('Could not save auction'); return 'retried-auction'; }).preview(true);
    page.button('Continue to Publish').props.onClick(); page.render();
    await page.button('Publish Auction').props.onClick(); page.render();
    assert.equal(page.dialog.open, true);
    assert.equal(page.locations.length, 0);
    const popup = page.find(node => node.type === 'dialog');
    assert.ok(nodes(popup).some(node => node.props?.role === 'alert' && node.props.children === 'Could not save auction'));
    assert.equal(page.button('Publish Auction').props.disabled, false);
    await page.button('Publish Auction').props.onClick();
    assert.deepEqual(page.locations, ['/auction/retried-auction']);
});


test('preview preserves listing values and editing choices in the compact summary', async () => {
    for (const escrow of [true, false]) {
        const writes = [];
        const page = harness(async listing => { writes.push(listing); return 'new-auction'; }).preview(escrow, {
            quantity: '2500', minimum: '1000000', buyout: '2000000', duration: '72',
        });
        const list = page.find(node => node.type === 'dl');
        const rows = React.Children.toArray(list.props.children);
        function content(element) {
            if (element == null) return '';
            if (typeof element !== 'object') return String(element);
            if (typeof element.type === 'function') return content(element.type(element.props));
            return React.Children.toArray(element.props?.children).map(content).join('');
        }
        assert.deepEqual(rows.map(row => React.Children.toArray(row.props.children).map(content)), [
            ['Quantity', '2,500'], ['Trading method', escrow ? 'Escrow' : 'Direct'], ['Minimum bid', '1,000,000 Meat'],
            ['Buyout price', '2,000,000 Meat'], ['Duration', '72 hours'],
        ]);
        const image = page.find(node => node.type === 'img');
        assert.equal(image.props.alt, 'asbestos ore');
        assert.match(image.props.className, /h-24 w-24/);
        assert.match(image.props.className, /image-rendering:pixelated/);
        const actions = nodes(page.tree).filter(node => node.type === 'button').slice(0, 2);
        assert.deepEqual(actions.map(node => node.props.children), ['Back to Edit', 'Continue to Publish']);
        page.button('Back to Edit').props.onClick(); page.render();
        assert.equal(page.find(node => node.props?.id === 'quantity').props.value, '2500');
        assert.equal(page.find(node => node.props?.id === 'instantPurchasePrice').props.value, '2000000');
        assert.equal(page.button(escrow ? 'Escrow' : 'Direct').props['aria-pressed'], true);
        assert.equal(writes.length, 0);
    }
});


test('escrow minimums above 1M cannot preview or publish until Direct is selected', async () => {
    for (const minimum of ['1.01m', '1,000,001', '1000001']) {
        const writes = [];
        const page = harness(async listing => { writes.push(listing); return 'direct-auction'; }).preview(true, { minimum });
        assert.equal(page.button('Preview Auction').props.disabled, true);
        assert.equal(page.find(node => node.props?.id === 'minBidMeat').props['aria-invalid'], true);
        assert.ok(nodes(page.tree).some(node => node.props?.id === 'escrow-minimum-error'));
        assert.ok(!nodes(page.tree).some(node => node.type === 'dialog'));
        assert.equal(writes.length, 0);
        page.button('Direct').props.onClick(); page.render();
        assert.equal(page.button('Preview Auction').props.disabled, false);
        assert.ok(!nodes(page.tree).some(node => node.props?.id === 'escrow-minimum-error'));
        page.preview(false, { minimum });
        page.button('Continue to Publish').props.onClick(); page.render();
        await page.button('Publish Auction').props.onClick();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].escrowMode, false);
        assert.ok(writes[0].minBidMeat > 1000000);
    }
});
