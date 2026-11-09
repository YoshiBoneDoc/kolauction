import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import * as React from 'react';
import * as browsing from '../src/lib/auctionBrowsing.js';
const require = createRequire(import.meta.url);
const source = readFileSync('src/components/ExploreAuctions.jsx', 'utf8').replace("from 'react'", "from 'test-hooks'");
const code = buildSync({ stdin: { contents: source, loader: 'jsx' }, write: false, platform: 'node', format: 'cjs', jsx: 'automatic' }).outputFiles[0].text;

test('type selection updates cards, scroll reset and browse link while keeping sort selection', () => {
    let cursor = 0;
    const slots = [];
    const hooks = {
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = value; }]; },
        useRef() { return { current: [] }; }, useEffect() {}, useMemo(fn) { return fn(); },
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => name === 'test-hooks' ? hooks : name === '../lib/auctionBrowsing' ? browsing : name === './StaticAuctionStrip' ? 'strip' : require(name), module, module.exports);
    const now = Date.now();
    const base = { status: 'active', item: 'Test', itemId: 1, endTime: now + 3600000, createdAt: now, minBidMeat: 100, dealMarketValueMeat: 100000, dealCheckedAt: new Date(now).toISOString() };
    const auctions = [{ ...base, id: 'direct', escrowMode: false }, { ...base, id: 'escrow', escrowMode: true }, { ...base, id: 'buy', auctionKind: 'buy', escrowMode: true, pricePerItem: 120000 }];
    function render() { cursor = 0; return module.exports.default({ auctions, now }).props; }
    let props = render();
    assert.equal(props.trailingControls.props['aria-label'], 'Explore auction type');
    props.headerControls.props.children.find(n => n.props.children === 'New').props.onClick();
    for (const [type, suffix] of [['buy', '&kind=buy'], ['escrow', '&kind=sell&trade=escrow'], ['direct', '&kind=sell&trade=direct'], ['all', '']]) {
        props = render();
        props.trailingControls.props.children.find(n => n.key === type).props.onClick();
        props = render();
        assert.equal(props.href, `/auctions?status=active&sort=newest${suffix}`);
        assert.equal(props.resetKey, `new-${type}`);
        assert.equal(props.trailingControls.props.children.find(n => n.key === type).props['aria-pressed'], true);
        if (type !== 'all') assert.deepEqual(props.auctions.map(a => a.id), [type]);
        assert.equal(React.Children.count(props.headerControls.props.children), 3);
    }
});
