import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: "export {default} from './src/components/RaffleFairness.jsx';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', supported: { 'dynamic-import': false }, packages: 'external', jsx: 'automatic', external: ['../lib/supabase', '../lib/raffleProof'] });
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
globalThis.window = new EventTarget();
let active, verificationFailure = false;
const verifiedInputs = [];
const calls = [], effects = [];
const summary = { required: true, complete: true, state: 'settled', commitmentHash: 'abc', committedAt: '2026-11-05T00:00:00Z', round: 42 };
const proof = { manifest: 'private technical ticket count 987654321', result: { winningTicket: '1' } };
function state(initial) {
    const h = active, i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [h.slots[i], value => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; }];
}
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? { ...React,
    useState: state, useRef: value => state({ current: value })[0],
    useEffect(fn, deps) { const [prior, set] = state(null); if (!prior || deps.some((v, i) => prior[i] !== v)) { set(deps); effects.push(fn); } },
} : name === 'react-router-dom' ? { Link: () => null } : name === '../lib/supabase' ? { supabase: { async rpc(name, args) { calls.push([name, args]); return { data: name === 'read_raffle_fairness_summary' ? summary : proof }; } } } : name === '../lib/raffleProof' ? { async verifyRaffleProof(data, savedHash) { verifiedInputs.push([data, savedHash]); if (verificationFailure) throw new Error('Commitment hash mismatch'); return { winningTicket: '1234', selectedOutcome: '2' }; } } : require(name), compiled, compiled.exports);
function harness() {
    const h = { slots: [], cursor: 0 };
    const cleanups = [];
    function visit(node) {
        if (Array.isArray(node)) return node.flatMap(visit);
        if (!node || typeof node !== 'object') return [];
        return [node, ...visit(React.Children.toArray(node.props?.children))];
    }
    return { render() { active = h; h.cursor = 0; this.tree = compiled.exports.default({ raffleId: 'raffle', viewerId: 'member', revision: 0 }); this.nodes = visit(this.tree); effects.splice(0).forEach(fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }); return this; },
        close() { cleanups.forEach(fn => fn()); },
        button(label) { return this.nodes.find(n => n.type === 'button' && (n.props['aria-label'] === label || n.props.children === label || n.props.children?.props?.children === label)); },
        text() { return this.nodes.map(n => typeof n.props?.children === 'string' ? n.props.children : '').join(' '); },
    };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('ticket totals and proof are fetched and displayed only after explicitly opening verification details', async () => {
    calls.length = 0;
    const h = harness().render(); await settle(); h.render();
    assert.deepEqual(calls.map(c => c[0]), ['read_raffle_fairness_summary']);
    assert.match(h.text(), /abc/);
    assert.ok(h.button('Copy hash'));
    assert.doesNotMatch(h.text(), /987654321/);
    assert.equal(h.nodes.some(n => n.type === 'dialog'), false);
    assert.equal(h.button('Copy proof values'), undefined);
    await h.button('Verification details').props.onClick(); h.render();
    assert.deepEqual(calls.map(c => c[0]), ['read_raffle_fairness_summary', 'read_raffle_fairness_proof']);
    assert.ok(h.nodes.some(n => n.type === 'dialog'));
    assert.match(h.text(), /987654321/);
    assert.ok(h.button('Copy proof values'));
    h.button('Close').props.onClick(); h.render();
    assert.doesNotMatch(h.text(), /987654321/);
    assert.equal(h.nodes.some(n => n.type === 'dialog'), false);
    h.close();
});

test('simple verification uses existing proof automatically, preserves optional hash checks and keeps advanced content collapsed', async () => {
    verificationFailure = false; verifiedInputs.length = 0;
    const h = harness().render(); await settle(); h.render();
    await h.button('Verification details').props.onClick(); h.render();
    const advanced = h.nodes.find(n => n.type === 'details' && n.props.className === 'raffle-proof-advanced');
    assert.ok(advanced); assert.notEqual(advanced.props.open, true);
    assert.ok(h.text().includes('Every raffle uses public randomness to select its winning ticket and prize. You can check the result yourself using the verification tool below.'));
    await h.button('Verify Winner & Prize').props.onClick(); h.render();
    assert.deepEqual(verifiedInputs[0], [proof, '']);
    assert.match(h.text(), /winning ticket \(#1234\) and prize both match the published proof/);
    const hashInput = h.nodes.find(n => n.type === 'input');
    hashInput.props.onChange({ target: { value: '  saved-hash  ' } }); h.render();
    verificationFailure = true;
    await h.button('Verify Winner & Prize').props.onClick(); h.render();
    assert.equal(verifiedInputs[1][1], 'saved-hash');
    assert.match(h.text(), /We couldn't verify this draw/);
    assert.ok(h.nodes.some(n => n.props?.role === 'alert'));
    assert.match(h.nodes.find(n => n.props?.role === 'note').props.children.join(''), /Commitment hash mismatch/);
    h.close();
});

test('backdrop clicks close the popup while inside clicks and drags from inside do not', async () => {
    const h = harness().render(); await settle(); h.render();
    await h.button('Verification details').props.onClick(); h.render();
    const dialog = h.nodes.find(n => n.type === 'dialog');
    const element = { getBoundingClientRect: () => ({ left: 10, right: 90, top: 10, bottom: 90 }) };
    const event = (x, y) => ({ currentTarget: element, target: element, clientX: x, clientY: y });
    dialog.props.onPointerDown(event(50, 50)); dialog.props.onClick(event(50, 50)); h.render();
    assert.ok(h.nodes.some(n => n.type === 'dialog'));
    dialog.props.onPointerDown(event(50, 50)); dialog.props.onClick(event(0, 0)); h.render();
    assert.ok(h.nodes.some(n => n.type === 'dialog'));
    dialog.props.onPointerDown(event(0, 0)); dialog.props.onClick(event(0, 0)); h.render();
    assert.equal(h.nodes.some(n => n.type === 'dialog'), false);
    h.close();
});

test('compact controls preserve labels, show refresh progress and confirm copying the exact hash', async () => {
    const h = harness().render(); h.render();
    assert.equal(h.button('Refresh proof').props['aria-busy'], true);
    assert.equal(h.button('Refresh proof').props.disabled, true);
    assert.equal(h.button('Refresh proof').props.title, 'Refresh proof');
    await settle(); h.render();
    assert.equal(h.button('Refresh proof').props.disabled, false);
    let copied;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(value) { copied = value; } } } });
    try {
        await h.button('Copy hash').props.onClick(); h.render();
        assert.equal(copied, summary.commitmentHash);
        assert.match(h.text(), /Copied!/);
        assert.equal(h.button('Verification details').props.className, 'raffle-verification-details');
        const link = h.nodes.find(n => n.props?.to === '/raffle/raffle/commitment');
        assert.equal(link.props.className, 'raffle-commitment-link');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
        else delete globalThis.navigator;
        h.close();
    }
});
