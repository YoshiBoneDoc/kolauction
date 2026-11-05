import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/AdminUserSearch.jsx', import.meta.url), 'utf8').replace("from 'react'", "from 'test-hooks'").replace("from '../lib/supabase'", "from 'test-backend'");
const code = buildSync({ stdin: { contents: source, loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', external: ['test-hooks', 'test-backend', 'react-router-dom', 'react/jsx-runtime'], jsx: 'automatic' }).outputFiles[0].text;
function fixture() {
    let cursor = 0, tree; const slots = [], calls = [], pending = [];
    function state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = v; }]; }
    const hooks = { useState: state, useRef: initial => state({ current: initial })[0], useEffect() {} };
    const backend = { supabase: { rpc: (name, args) => { calls.push({ name, args }); return new Promise(resolve => pending.push(resolve)); } } };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => name === 'test-hooks' ? hooks : name === 'test-backend' ? backend : name === 'react-router-dom' ? { Link: 'a' } : require(name), module, module.exports);
    function nodes(n) { return !n || typeof n !== 'object' ? [] : [n, ...React.Children.toArray(n.props?.children).flatMap(nodes)]; }
    return { calls, pending, render() { cursor = 0; tree = module.exports.default(); }, find(fn) { return nodes(tree).find(fn); }, all() { return nodes(tree); } };
}
test('submitted player ID searches server and returns a clickable seller profile', async () => {
    const f = fixture(); f.render(); assert.equal(f.calls.length, 0);
    f.find(n => n.type === 'input').props.onChange({ target: { value: '3866009' } }); f.render();
    const promise = f.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(f.calls, [{ name: 'search_admin_users', args: { p_query: '3866009' } }]);
    f.pending[0]({ data: { users: [{ id: 'account-uuid', username: 'KH_neonep', kol_player_name: 'neonep', kol_player_id: 3866009 }] } }); await promise; f.render();
    const link = f.find(n => n.type === 'a'); assert.equal(link.props.to, '/seller/account-uuid'); assert.equal(link.props.children, 'neonep');
});
test('stale search results are discarded after editing the query', async () => {
    const f = fixture(); f.render(); f.find(n => n.type === 'input').props.onChange({ target: { value: 'old' } }); f.render();
    const promise = f.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    f.find(n => n.type === 'input').props.onChange({ target: { value: 'new' } });
    f.pending[0]({ data: { users: [{ id: 'old', username: 'old' }] } }); await promise; f.render();
    assert.equal(f.find(n => n.type === 'a'), undefined);
});
test('authorization errors are displayed without exposing database errors', async () => {
    const f = fixture(); f.render(); f.find(n => n.type === 'input').props.onChange({ target: { value: 'name' } }); f.render();
    const promise = f.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
    f.pending[0]({ error: { code: '42501', message: 'private raw evidence' } }); await promise; f.render();
    assert.equal(f.find(n => n.props?.role === 'alert').props.children, 'Administrator access required.');
});
