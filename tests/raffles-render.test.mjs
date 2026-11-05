import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
const bundle = buildSync({ stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Summary from './src/components/RaffleSummary.jsx'; import Card from './src/components/HomeRaffleCard.jsx'; import BrowseCard from './src/components/RaffleAuctionCard.jsx'; import Strip from './src/components/StaticAuctionStrip.jsx'; import {StaticRouter} from 'react-router-dom'; export const renderBrowseCard = (raffle) => renderToStaticMarkup(<StaticRouter location='/auctions'><BrowseCard raffle={raffle}/></StaticRouter>); export const renderCard = (raffle) => renderToStaticMarkup(<StaticRouter location='/'><Strip auctions={[]} now={0} title='High Rollers' label='High Rollers' leadingCards={<li><Card raffle={raffle}/></li>} /></StaticRouter>); export const render = (raffle) => renderToStaticMarkup(<Summary raffle={raffle} now={0}/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
test('raffle presentation shows separate outcomes, Escrow and unavailable participation', () => {
    const html = compiled.exports.render({ name: 'Mystery Raffle', ticket_price: 1000000, ends_at: '2026-11-11T12:00:00Z', prizes: [{ item_id: 1, name: 'Prize One', image: 'prize.gif', quantity: 20, probability_bps: 2500 }, { item_id: 2, name: 'Prize Two', image: 'two.gif', quantity: 1, probability_bps: 7500 }] });
    for (const text of ['Mystery Raffle', 'Escrow', 'Raffle', 'Prize One', 'Prize Two', '1,000,000', 'Preview', '25.00%', '75.00%']) assert.ok(html.includes(text), text);
    assert.equal((html.match(/<li>/g) || []).length, 2);
    assert.doesNotMatch(html, /<button|Buy ticket|Place Bid|participant count|estimated revenue/);
});

test('home raffle card uses the dedicated route, fixed artwork, ticket value and Raffle badge', () => {
    const html = compiled.exports.renderCard({ id: 'raffle-id', name: 'My Mystery Raffle', ticket_price: 1000000, ends_at: '2026-11-11T12:00:00Z' });
    for (const text of ['My Mystery Raffle', '/raffle/raffle-id', 'Rafflebox.gif', '/ ticket', 'Ends in', 'home-raffle-label']) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /Escrow|Min:|Place Bid|participant|revenue/);
});

test('browse raffle card matches grid height and contains no auction transaction controls', () => {
    const html = compiled.exports.renderBrowseCard({ id: 'raffle-id', name: 'Mystery Raffle', ticket_price: 1000000, ends_at: '2026-11-11T12:00:00Z' });
    for (const text of ['h-[134px]', '/raffle/raffle-id', 'Mystery Raffle', 'Rafflebox.gif', '/ ticket', 'Raffle']) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /Escrow|Place Bid|<button|Buyout/);
});

test('cards show only the supplied private count with exact large-integer titles', () => {
    const raffle = { id: 'private', name: 'Private tickets', ticket_price: 1, ends_at: '2026-11-11T12:00:00Z', user_ticket_count: '9007199254740993' };
    for (const html of [compiled.exports.renderCard(raffle), compiled.exports.renderBrowseCard(raffle)]) {
        assert.ok(html.includes('Your tickets: 9,007,199,254,740,993'));
        assert.doesNotMatch(html, /revenue|total tickets/i);
    }
});
