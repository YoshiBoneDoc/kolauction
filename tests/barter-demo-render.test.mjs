import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderRouteMarkup } from './tests/helpers/renderRouteMarkup.mjs';
    import { StaticRouter } from 'react-router-dom';
    import App from './src/App.jsx';
    import Cards from './src/components/BarterDemoCards.jsx';
    import { UserContext } from './src/context/UserContext.jsx';
    import { AuctionsContext } from './src/context/AuctionsContext.jsx';
    export function render(role) {
        return renderRouteMarkup(<StaticRouter location={'/barter/demo/'+role}><UserContext.Provider value={{currentUser:null}}><AuctionsContext.Provider value={{auctions:[],total:0}}><App /></AuctionsContext.Provider></UserContext.Provider></StaticRouter>);
    }
    export function cards() { return renderRouteMarkup(<StaticRouter><Cards /></StaticRouter>); }
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, loader: { '.gif': 'dataurl', '.svg': 'dataurl', '.css': 'empty' } });
const compiled = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? { ...router, BrowserRouter: ({ children }) => children } : require(name), compiled, compiled.exports);

test('host and bidder practice routes render for guests without opening real barter details', async () => {
    for (const role of ['host', 'bidder']) {
        const html = await compiled.exports.render(role);
        assert.match(html, /DEMO \/ FAKE — no items or Meat exchanged/);
        assert.match(html, new RegExp(`Play as the ${role}`));
        assert.match(html, /Reset demo/);
        assert.match(html, /Preview auction ending/);
        assert.match(html, /Accepted bid history/);
        assert.doesNotMatch(html, /Loading barter…|Barter not found\.|Log in<\/a> to offer/);
        if (role === 'host') {
            assert.match(html, /Review sample offers/);
            assert.equal((html.match(/>Request Changes<\/button>/g) || []).length, 3);
        } else {
            assert.match(html, /Your offer and host feedback/);
            assert.match(html, /Host requests changes/);
            assert.match(html, /Revise Offer/);
            assert.match(html, /Submit practice offer/);
        }
    }
});
test('demo cards identify their fake status and navigate to separate practice routes', async () => {
    const html = await compiled.exports.cards();
    assert.equal((html.match(/DEMO \/ FAKE/g) || []).length, 2);
    assert.match(html, /href="\/barter\/demo\/host"/);
    assert.match(html, /href="\/barter\/demo\/bidder"/);
    assert.doesNotMatch(html, /Place Bid|Ends in/);
    assert.match(await compiled.exports.render('unknown'), /Practice auction not found/);
});
