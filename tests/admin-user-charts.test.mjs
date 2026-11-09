import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const code = buildSync({ entryPoints: ['src/components/AdminUserCharts.jsx'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic' }).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(require, module, module.exports);
function nodes(n) {
    if (!n || typeof n !== 'object') return [];
    if (typeof n.type === 'function') return nodes(n.type(n.props));
    return [n, ...React.Children.toArray(n.props?.children).flatMap(nodes)];
}
const render = props => nodes(React.createElement(module.exports.default, props));
test('rolling registration bars expose exact counts and share the responsive chart grid', () => {
    const tree = render({ registrationCounts: ['0', '7', '1234'] });
    assert.ok(tree.some(n => n.props.className?.includes('md:grid-cols-2')));
    const bars = tree.filter(n => n.type === 'rect');
    assert.equal(bars.length, 3);
    assert.deepEqual(bars.map(n => n.props['aria-label']), ['Last 24 Hours · New accounts: 0', 'Last 7 Days · New accounts: 7', 'Last 30 Days · New accounts: 1,234']);
    assert.equal(tree.filter(n => n.type === 'title').length, 3);
    assert.ok(tree.some(n => n.type === 'table' && n.props.className === 'sr-only'));
});
test('missing login events are unavailable, never fabricated zero bars', () => {
    const tree = render({ registrationCounts: ['1', '2', '3'] });
    assert.ok(tree.some(n => n.type === 'p' && n.props.children === 'Unavailable: successful login events are not currently recorded for analytics.'));
    assert.equal(tree.filter(n => n.type === 'svg').length, 2);
    assert.equal(tree.filter(n => n.type === 'rect').length, 3);
});
test('older database responses preserve the page with a migration notice', () => {
    const tree = render({});
    assert.equal(tree.filter(n => n.type === 'rect').length, 0);
    assert.ok(tree.some(n => n.type === 'p' && n.props.children?.includes?.('Apply the user charts database migration.')));
});


test('recorded login counts render adjacent series with exact values', () => {
    const tree = render({ registrationCounts: ['0','1','2'], loginActivity: {
        status: 'recording', recording_since: '2026-11-09T12:00:00Z',
        unique_users: ['2','3','4'], total_logins: ['5','7','9'],
    } });
    assert.equal(tree.filter(n => n.type === 'rect').length, 9);
    const labels = tree.filter(n => n.type === 'rect').map(n => n.props['aria-label']);
    assert.ok(labels.includes('Last 24 Hours · Unique Active Users: 2'));
    assert.ok(labels.includes('Last 24 Hours · Total Logins: 5'));
});
