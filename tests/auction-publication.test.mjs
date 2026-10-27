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
        preview(escrow, { quantity = '1', minimum = '100', buyout = '', duration = '24', customEndTime = '' } = {}) {
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
            try {
                if (customEndTime) {
                    result.button('Custom').props.onClick(); result.render(); result.input('customEndTime', customEndTime);
                }
                result.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
            }
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
            ['Quantity', '2,500'], ['Trading method', escrow ? 'Escrow' : 'Direct'], ['Minimum bid (whole listing)', '1,000,000 Meat'],
            ['Buyout price (whole listing)', '2,000,000 Meat'], ['Duration', '72 hours'],
            ...(escrow ? [['Estimated Tiered Fee (5%) at minimum bid','50,000 Meat']] : []),
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


test('Escrow starting bids above 1M can preview and publish without switching settlement mode', async () => {
    for (const minimum of ['1.01m', '1,000,001', '1000001', '10b']) {
        const writes = [];
        const page = harness(async listing => { writes.push(listing); return 'escrow-auction'; }).preview(true, { minimum });
        assert.ok(nodes(page.tree).some(node => node.type === 'dialog'));
        assert.ok(!nodes(page.tree).some(node => node.props?.id === 'escrow-minimum-error'));
        page.button('Continue to Publish').props.onClick(); page.render();
        await page.button('Publish Auction').props.onClick();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].escrowMode, true);
        assert.ok(writes[0].minBidMeat > 1000000);
    }
});


import {localDateTimeInput,customAuctionEnd} from '../src/lib/auctionSchedule.js';
test('custom date/time is preserved through preview, editing, confirmation and both trading methods', async () => {
    const ending=localDateTimeInput(Date.now()+7200000);
    for(const escrow of [true,false]) {
        const writes=[];
        const page=harness(async listing=>{writes.push(listing);return 'custom-auction';}).preview(escrow,{customEndTime:ending});
        assert.ok(nodes(page.tree).some(n=>n.type==='dt' && n.props.children==='Ending time'));
        page.button('Back to Edit').props.onClick();page.render();
        assert.equal(page.find(n=>n.props?.id==='customEndTime').props.value,ending);
        assert.equal(page.find(n=>n.props?.id==='auctionTime').props.disabled,true);
        page.button('Custom').props.onClick();page.render();
        assert.equal(page.find(n=>n.props?.id==='auctionTime').props.disabled,false);
        assert.ok(!nodes(page.tree).some(n=>n.props?.id==='customEndTime'));
        const frame=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();
        try{page.button('Custom').props.onClick();}finally{if(frame)globalThis.requestAnimationFrame=frame;else delete globalThis.requestAnimationFrame;}
        page.render();
        assert.equal(page.find(n=>n.props?.id==='customEndTime').props.value,ending);
        const original=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();
        try{page.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});}finally{if(original)globalThis.requestAnimationFrame=original;else delete globalThis.requestAnimationFrame;}
        page.render();page.button('Continue to Publish').props.onClick();page.render();await page.button('Publish Auction').props.onClick();
        assert.equal(writes.length,1);assert.equal(writes[0].customEndAt,customAuctionEnd(ending));assert.equal(writes[0].escrowMode,escrow);
    }
});
test('custom ending validation blocks stale and overly distant selections before preview', () => {
    for(const ending of [localDateTimeInput(Date.now()-60000),localDateTimeInput(Date.now()+31*86400000)]) {
        const page=harness(()=>assert.fail('must not publish')).preview(true,{customEndTime:ending});
        assert.ok(nodes(page.tree).some(n=>n.props?.role==='alert'));
        assert.ok(nodes(page.tree).some(n=>n.type==='form'));
    }
});


test('Buy mode defaults from Sell, disables Direct, removes sell terms and publishes per-item funded orders',async()=>{
    const writes=[];const page=harness(async listing=>{writes.push(listing);return 'buy-order';}).render();
    assert.equal(page.button('Sell Items').props['aria-pressed'],true);
    page.button('Direct').props.onClick();page.render();
    page.button('Buy Items').props.onClick();page.render();
    assert.equal(page.button('Direct').props.disabled,true);assert.equal(page.button('Escrow').props['aria-pressed'],true);
    assert.equal(nodes(page.tree).some(n=>n.props?.children==='Set Buyout Price (optional)'),false);
    assert.equal(nodes(page.tree).some(n=>n.type==='strong'&&n.props.children==='Escrow Protection Guarantee:'),false);
    page.input('listing-item-search','asbestos ore').input('item','364').input('quantity','20').input('minBidMeat','2m').input('deliveryMode','finished');
    const original=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>fn();
    try {page.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});}finally{if(original)globalThis.requestAnimationFrame=original;else delete globalThis.requestAnimationFrame;}
    page.render();assert.equal(nodes(page.tree).some(n=>n.type==='dt'&&n.props.children==='Price per item'),true);
    await page.button('Publish Auction').props.onClick();page.render();
    assert.equal(writes.length,1);assert.equal(writes[0].auctionKind,'buy');assert.equal(writes[0].deliveryMode,'finished');assert.equal(writes[0].escrowMode,true);assert.equal(writes[0].minBidMeat,2000000);assert.equal(writes[0].instantPurchasePrice,null);
});
