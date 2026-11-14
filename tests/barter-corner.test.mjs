import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';

const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/pages/BarterCorner.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    external: ['../hooks/useBarterRead'], define: { 'import.meta.env': '{}' },
});
let params = new URLSearchParams();
let request;
const compiled = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? {
    ...React, useState: value => [value, () => {}], useEffect() {},
} : name === '../hooks/useBarterRead' ? (rpc, args) => { request = { rpc, args }; return { data: { rows: [], more: false } }; }
    : name === 'react-router-dom' ? { ...require(name), useSearchParams: () => [params, next => { params = next(params); }] }
    : require(name), compiled, compiled.exports);
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }
test('barter browse requests only separate live rows and resets pagination on sorting', () => {
    params = new URLSearchParams('q=clover&page=3');
    let tree = nodes(compiled.exports.default());
    assert.deepEqual(request, { rpc: 'read_barter_auctions', args: { p_search: 'clover', p_sort: 'ending', p_page: 3 } });
    const buttons = tree.filter(n => n.type === 'button' && n.props['aria-pressed'] != null);
    assert.deepEqual(buttons.map(n => n.props.children), ['Ending Soon', 'Newest', 'Recent Activity']);
    buttons[2].props.onClick();
    tree = nodes(compiled.exports.default());
    assert.deepEqual(request.args, { p_search: 'clover', p_sort: 'activity', p_page: 1 });
    assert.ok(tree.some(n => n.props?.children === 'No barter listings match your search.'));
});
