import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Exercise component handlers and rendered controls with a deterministic hook
// harness. This supplements database authorization tests; it is not a browser.
const require = createRequire(import.meta.url);
const code = readFileSync(new URL('../src/components/AdminEscrowPromotion.jsx', import.meta.url), 'utf8')
    .replace("from 'react'", "from 'promotion-test-hooks'")
    .replace("from '../lib/supabase'", "from 'promotion-test-backend'")
    .replace("from '../lib/escrowPromotionService'", "from 'promotion-test-service'");
const { outputFiles } = buildSync({ stdin: { contents: code, loader: 'jsx' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', external: ['promotion-test-*', 'react/jsx-runtime'] });
function fixture() {
    const state = [], effects = []; let cursor = 0, enabled = true, fail = false, invalidations = 0;
    const calls = [];
    const hooks = {
        useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial;
            return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
        useEffect(callback, deps) { const i = cursor++; if (!state[i] || deps.some((v,j) => v !== state[i][j])) { state[i] = deps; effects.push(callback); } },
    };
    const backend = { supabase: { async rpc(name, args) {
        calls.push({ name, args });
        if (fail) { fail = false; return { error: { message: 'Connection failed' } }; }
        if (args) enabled = args.p_enabled;
        return { data: { enabled } };
    } } };
    const compiled = { exports: {} };
    const mockedRequire = name => name === 'promotion-test-hooks' ? hooks : name === 'promotion-test-backend' ? backend
        : name === 'promotion-test-service' ? { escrowPromotion: { invalidate() { invalidations++; } } } : require(name);
    new Function('require', 'module', 'exports', outputFiles[0].text)(mockedRequire, compiled, compiled.exports);
    return { calls, fail: () => { fail = true; }, invalidations: () => invalidations,
        render() { cursor = 0; return compiled.exports.default(); },
        async effects() { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)); } };
}
function elements(tree, type) {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(child => elements(child,type));
    return [...(tree.type === type ? [tree] : []), ...elements(tree.props?.children,type)];
}
function button(tree, text) { return elements(tree,'button').find(node => node.props.children === text); }

test('status loads, disable and enable buttons send explicit states and invalidate previews', async () => {
    const f = fixture();
    assert.equal(button(f.render(),'Enable promotion').props.disabled, true);
    await f.effects();
    await button(f.render(),'Disable promotion').props.onClick();
    assert.deepEqual(f.calls.at(-1), { name:'admin_escrow_promotion', args:{ p_enabled:false } });
    assert.equal(button(f.render(),'Enable promotion').props.disabled, false);
    await button(f.render(),'Enable promotion').props.onClick();
    assert.equal(f.calls.at(-1).args.p_enabled, true); assert.equal(f.invalidations(), 2);
});

test('uncertain toggle errors disable writes until status is successfully reloaded', async () => {
    const f = fixture(); f.render(); await f.effects();
    f.fail(); await button(f.render(),'Disable promotion').props.onClick();
    let tree = f.render();
    assert.equal(button(tree,'Enable promotion').props.disabled, true);
    assert.equal(elements(tree,'p').some(node => node.props.role === 'alert'), true);
    button(tree,'Refresh status').props.onClick(); f.render(); await f.effects();
    tree = f.render(); assert.equal(button(tree,'Disable promotion').props.disabled, false);
});
