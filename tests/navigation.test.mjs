import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { activeNavigationPath } from '../src/lib/navigation.js';

const { outputFiles } = buildSync({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { StaticRouter } from 'react-router-dom';
            import App from './src/App.jsx';
            import { AuctionsContext } from './src/context/AuctionsContext.jsx';
            import { UserContext } from './src/context/UserContext.jsx';
            export function render(path, currentUser = null, state = {}, auth = {}) {
                return renderToStaticMarkup(<StaticRouter location={path}>
                    <UserContext.Provider value={{ currentUser, ...auth }}>
                        <AuctionsContext.Provider value={{ auctions: [], isLoading: false, error: '', ...state }}>
                            <App />
                        </AuctionsContext.Provider>
                    </UserContext.Provider>
                </StaticRouter>);
            }
        `,
        resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { render } = compiled.exports;
const navigation = html => html.match(/<nav aria-label="Main navigation"[\s\S]*?<\/nav>/)?.[0];

test('all routed pages render one shared navbar with every primary destination', () => {
    const paths = ['/', '/auctions', '/auction/example', '/auction/example/trade-query', '/auction/example/report-trade',
        '/seller/example', '/auction-item', '/info', '/donate', '/wall-of-shame', '/login', '/register',
        '/forgot-password', '/resend-confirmation', '/reset-password', '/change-password', '/auth/confirm',
        '/profile', '/support', '/report-a-bug', '/submit-appeal', '/admin/inbox', '/admin/bug-reports', '/unknown-page'];
    for (const path of paths) {
        const html = render(path);
        assert.equal((html.match(/aria-label="Main navigation"/g) || []).length, 1, path);
        assert.doesNotMatch(html, /aria-label="Page navigation"/, path);
        const nav = navigation(html);
        for (const destination of ['/', '/auctions', '/auction-item', '/info', '/wall-of-shame', '/login', '/register']) {
            assert.ok(nav.includes(`href="${destination}"`), `${path}: ${destination}`);
        }
    }
});

test('active links follow nested auction, account, help and admin routes without marking Home', () => {
    const cases = [['/', '/'], ['/auctions/?q=tooth', '/auctions'], ['/auction/example', '/auctions'],
        ['/auction/example/trade-query', '/auctions'], ['/seller/example?view=stats', '/auctions'],
        ['/auction-item', '/auction-item'], ['/info', '/info'], ['/support', '/info'], ['/donate', '/info'],
        ['/wall-of-shame', '/wall-of-shame'], ['/profile/', '/profile'], ['/change-password', '/profile'],
        ['/login', '/login'], ['/register', '/register']];
    for (const [path, expected] of cases) {
        const nav = navigation(render(path, { id: 'user', khubUsername: 'KH_Tester' }));
        const active = [...nav.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
        // Signed-in visitors retain their account link rather than guest links.
        if (expected === '/login' || expected === '/register') assert.equal(active.length, 0);
        else { assert.equal(active.length, 1, path); assert.ok(active[0][0].includes(`href="${expected}"`), path); }
    }
    assert.equal(activeNavigationPath('/admin/bug-reports/'), '/admin/inbox');
    assert.equal(activeNavigationPath('/auction-item'), '/auction-item');
    assert.equal(activeNavigationPath('/unrecognized'), null);
});

test('account links and useful Back links remain available without duplicate Home headers', () => {
    const nav = navigation(render('/profile', { id: 'user', khubUsername: 'KH_Tester' }));
    assert.match(nav, /KH_Tester/);
    assert.match(nav, /Log Out/);
    assert.doesNotMatch(nav, />Log In<|>Register</);
    assert.match(render('/auction/example'), /Back to Auctions/);
    assert.match(render('/auction/example/trade-query'), /Back to auction/);
    for (const path of ['/donate', '/login', '/register', '/auction-item', '/profile', '/change-password']) {
        assert.doesNotMatch(render(path), />Back<\/button>/, path);
    }
    assert.doesNotMatch(render('/'), />Back<\/button>/);
    for (const state of [{ isLoading: true }, { error: 'Unavailable' }]) {
        assert.ok(navigation(render('/auction/example', null, state)));
    }
});


test('load-error messages stay below the navbar and restricted appeals retain signed-in navigation', () => {
    const html = render('/auctions', null, { error: 'Auction data unavailable' });
    assert.ok(html.indexOf('Main navigation') < html.indexOf('Auction data unavailable'));
    assert.match(html, />Retry<\/button>/);
    const appeal = render('/submit-appeal', null, {}, { restrictedAccount: { id: 'restricted', khubUsername: 'KH_Restricted' }, signedInUserId: 'restricted' });
    const nav = navigation(appeal);
    assert.match(nav, /KH_Restricted/);
    assert.match(nav, /Log Out/);
    assert.doesNotMatch(nav, />Log In<|>Register</);
    assert.match(appeal, /Back to account status/);
});
