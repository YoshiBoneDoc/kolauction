import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const built = buildSync({ stdin: { contents: `export {default as Instructions} from './src/components/KmailInstructions.jsx';
export {UserContext} from './src/context/UserContext.jsx';`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, compiled, compiled.exports);
const { Instructions, UserContext } = compiled.exports;
const auction = { id: 'id', auctionNumber: '1001', item: 'seal tooth', quantity: 1, minBidMeat: 1_000_000,
    currentBid: 0, mrARate: 70_000_000, instantPurchasePrice: 150_000_000, escrowMode: true };
const render = (mode, value = auction) => renderToStaticMarkup(React.createElement(UserContext.Provider,
    { value: { currentUser: { id: 'user', kolPlayerId: 1234 } } }, React.createElement(Instructions, { auction: value, mode })));
test('mixed escrow instructions show the locked rate and safe buyout/refund rules', () => {
    const html = render('bid');
    assert.match(html, /70,000,000/);
    assert.match(html, /Meat, Mr. Accessories, or both/);
    assert.match(html, /entire payment is rejected and returned/);
    assert.match(html, /exact original assets/);
});
test('seller deposits and existing Meat-only bids retain their original instructions', () => {
    assert.match(render('list'), /no Meat or extra items/);
    const html = render('bid', { ...auction, mrARate: null });
    assert.match(html, /with no items/);
    assert.doesNotMatch(html, /fixed rate/);
});
