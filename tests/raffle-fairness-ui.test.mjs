import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: "export {default} from './src/components/RaffleFairness.jsx';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', external: ['../lib/supabase', '../lib/raffleProof'] });
let active;
const calls = [], effects = [];
const summary = { required: true, complete: true, state: 'settled', commitmentHash: 'abc' };
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
} : name === '../lib/supabase' ? { supabase: { async rpc(name, args) { calls.push([name, args]); return { data: name === 'read_raffle_fairness_summary' ? summary : proof }; } } } : require(name), compiled, compiled.exports);
function harness() {
    const h = { slots: [], cursor: 0 };
    function visit(node) {
        if (Array.isArray(node)) return node.flatMap(visit);
        if (!node || typeof node !== 'object') return [];
        return [node, ...visit(React.Children.toArray(node.props?.children))];
    }
    return { render() { active = h; h.cursor = 0; this.tree = compiled.exports.default({ raffleId: 'raffle', viewerId: 'member', revision: 0 }); this.nodes = visit(this.tree); effects.splice(0).forEach(fn => fn()); return this; },
        button(label) { return this.nodes.find(n => n.type === 'button' && n.props.children === label); },
        text() { return this.nodes.map(n => typeof n.props?.children === 'string' ? n.props.children : '').join(' '); },
    };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('ticket totals and proof are fetched and displayed only after explicitly opening verification details', async () => {
    calls.length = 0;
    const h = harness().render(); await settle(); h.render();
    assert.deepEqual(calls.map(c => c[0]), ['read_raffle_fairness_summary']);
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
});
