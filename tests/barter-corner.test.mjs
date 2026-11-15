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
let rows = [];
const compiled = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? {
    ...React, useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect() {},
} : name === '../hooks/useBarterRead' ? (rpc, args) => { request = { rpc, args }; return { data: { rows, more: false } }; }
    : name === 'react-router-dom' ? { ...require(name), useSearchParams: () => [params, next => { params = next(params); }] }
    : require(name), compiled, compiled.exports);
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }
function menu(tree, label) { return tree.find(n => n.props?.ariaLabel === label); }

test('barter browse defaults to active and resets pagination on sorting', () => {
    params = new URLSearchParams('q=clover&page=3');
    let tree = nodes(compiled.exports.default());
    assert.deepEqual(request, { rpc: 'read_barter_auctions', args: { p_search: 'clover', p_sort: 'ending', p_page: 3, p_status: 'active' } });
    const sort = menu(tree, 'Sort barter auctions');
    assert.deepEqual(sort.props.options.map(([, label]) => label), ['Ending Soon', 'Newest', 'Recent Activity']);
    sort.props.onChange('activity');
    tree = nodes(compiled.exports.default());
    assert.deepEqual(request.args, { p_search: 'clover', p_sort: 'activity', p_page: 1, p_status: 'active' });
    assert.ok(tree.some(n => n.props?.children === 'No barter listings match your search.'));
});

test('status choices reflect barter outcomes, reset page/sort and preserve search', () => {
    params = new URLSearchParams('q=clover&page=3&sort=activity');
    let tree = nodes(compiled.exports.default());
    const status = menu(tree, 'Barter status');
    assert.deepEqual(status.props.options.map(([value]) => value), ['all', 'active', 'cancelled', 'expired', 'ended']);
    status.props.onChange('ended');
    tree = nodes(compiled.exports.default());
    assert.equal(params.has('page'), false);
    assert.equal(params.has('sort'), false);
    assert.deepEqual(request.args, { p_search: 'clover', p_sort: 'ended-desc', p_page: 1, p_status: 'ended' });
    assert.deepEqual(menu(tree, 'Sort barter auctions').props.options[0], ['ended-desc', 'Recently Ended']);
});

test('status URLs validate inputs and preserve server-confirmed card outcomes', () => {
    for (const status of ['all', 'active', 'cancelled', 'expired', 'ended']) {
        params = new URLSearchParams({ status });
        compiled.exports.default();
        assert.equal(request.args.p_status, status);
    }
    params = new URLSearchParams('status=completed&sort=invalid');
    compiled.exports.default();
    assert.equal(request.args.p_status, 'active');
    assert.equal(request.args.p_sort, 'ending');
    rows = [{ id: 'closed', status: 'cancelled', endTime: Date.now() + 86400000 }];
    const tree = nodes(compiled.exports.default());
    assert.equal(tree.find(n => n.props?.auction?.id === 'closed').props.auction.status, 'cancelled');
    rows = [];
});
