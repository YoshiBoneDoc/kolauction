import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';

const { outputFiles } = buildSync({
    stdin: { contents: `export {default as InfoPage} from './src/pages/InfoPage.jsx'; export {UserContext} from './src/context/UserContext.jsx';`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, loader: { '.css': 'empty' },
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { InfoPage, UserContext } = compiled.exports;
function render(currentUser) {
    return renderToStaticMarkup(React.createElement(StaticRouter, { location: '/info' },
        React.createElement(UserContext.Provider, { value: { currentUser } }, React.createElement(InfoPage))));
}
test('club history is hidden until a signed-in account has confirmed membership', () => {
    for (const user of [null, {}, { id: 'member' }, { id: 'member', isHighRollersMember: false }, { id: 'viewer', canViewRaffles: true }, { isHighRollersMember: true }, { isAdmin: true }]) {
        const html = render(user);
        assert.doesNotMatch(html, /MMG High Rollers Club|invite-only club raffle/);
        assert.match(html, /Official launch of kHub/);
    }
});
test('signed-in administrators can see club history without club membership', () => {
    const html = render({ id: 'admin', isAdmin: true, isHighRollersMember: false });
    assert.match(html, /MMG High Rollers Club/);
    assert.match(html, /invite-only club raffle/);
});
test('confirmed members see both milestones and blank winner and prize fields', () => {
    const html = render({ id: 'member', isHighRollersMember: true });
    assert.match(html, /MMG High Rollers Club founded/);
    assert.match(html, /First invite-only club raffle/);
    assert.doesNotMatch(html, /\[Winner\]|\[Prize\]/);
    assert.ok(html.indexOf('Meat Stack Mania') < html.indexOf('MMG High Rollers Club'));
    assert.doesNotMatch(render(null), /MMG High Rollers Club/);
});
