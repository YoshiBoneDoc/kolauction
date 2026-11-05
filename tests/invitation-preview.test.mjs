import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: "export {default} from './src/components/HighRollersInvitation.jsx';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, external: ['../context/UserContext', '../lib/supabase'] });
let admin = true, calls = 0;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => {
    if (name === 'react') return { ...React, useContext: () => ({ currentUser: { id: 'viewer', isAdmin: admin } }), useState: initial => [initial, () => {}], useEffect: callback => callback() };
    if (name === '../context/UserContext') return { UserContext: {} };
    if (name === '../lib/supabase') return { supabase: { rpc() { calls++; throw new Error('Preview must never call the database'); } } };
    return require(name);
}, compiled, compiled.exports);
function nodes(element) {
    if (!element || typeof element !== 'object') return [];
    return [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
}
test('admin preview shows the real invitation and its buttons only close the preview', async () => {
    admin = true; calls = 0; let closed = 0;
    const tree = compiled.exports.default({ preview: true, onPreviewClose: () => closed++ });
    const all = nodes(tree);
    const buttons = all.filter(n => n.type === 'button');
    assert.deepEqual(buttons.map(n => n.props.children), ['Close preview', 'Decline', 'Accept Invitation']);
    for (const button of buttons) await button.props.onClick();
    assert.equal(closed, 3);
    assert.equal(calls, 0);
    assert.ok(all.some(n => n.type === 'h2' && n.props.children === "You've Been Invited."));
});
test('preview cannot be displayed by a non-administrator and makes no database calls', () => {
    admin = false; calls = 0;
    assert.equal(compiled.exports.default({ preview: true }), null);
    assert.equal(calls, 0);
});
