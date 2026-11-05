import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
const bundle = buildSync({ stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {RafflePrizeDisplay} from './src/components/RaffleShowcase.jsx'; export const render=(raffle,prices,winner)=>renderToStaticMarkup(<RafflePrizeDisplay raffle={raffle} marketPrices={prices} winnerResult={winner} now={Date.parse('2026-11-05T08:00:00Z')}/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty', '.svg': 'dataurl' }, define: { 'import.meta.env': '{}' } });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const raffle = { name: 'Mystery raffle', raffle_number: 1006, ticket_price: 1000, ends_at: '2026-11-05T06:00:00Z', state: 'settled', completion_reason: 'prize_delivered', selected_outcome: 2, prizes: [
    { outcome: 1, item_id: 1, name: 'First prize', quantity: 1, probability_bps: 3334, image: 'one.gif' },
    { outcome: 2, item_id: 2, name: 'Winning prize name', quantity: 3, probability_bps: 3333, image: 'two.gif' },
    { outcome: 3, item_id: 3, name: 'Unpriced prize', quantity: 1, probability_bps: 3333, image: 'three.gif' },
] };
test('raffle reveal orders known prizes by total value and places unavailable values last', () => {
    const html = compiled.exports.render(raffle, new Map([[1, { available: true, price_meat: 100 }], [2, { available: true, price_meat: 50 }]]));
    const items = html.match(/<li\b[\s\S]*?<\/li>/g);
    assert.match(items[0], /Winning prize name/);
    assert.match(items[1], /First prize/);
    assert.match(items[2], /Unpriced prize/);
    assert.match(html, /data:image\/svg\+xml/);
    assert.doesNotMatch(html, /What’s in the box|Highest to lowest current Mall value/);
    assert.doesNotMatch(html, /raffle-ink-orbit|raffle-box-paper|Rafflebox.gif/);
    assert.match(html, /Concluded/);
    assert.doesNotMatch(html, /settled/);
    assert.equal((html.match(/class="raffle-orbit-prize is-winning-prize"/g) || []).length, 1);
    assert.match(items[0], /x 3/);
    assert.match(items[0], /33.3% chance/);
});
test('canceled and empty raffles do not claim a winning prize or successful conclusion', () => {
    for (const reason of ['cancelled', 'no_tickets']) {
        const html = compiled.exports.render({ ...raffle, completion_reason: reason, selected_outcome: null });
        assert.doesNotMatch(html, /is-concluded|is-winning-prize/);
    }
});
test('active and finalizing raffles display correct status without suggesting a selected winner', () => {
    for (const [end, text] of [['2026-11-05T09:00:00Z', 'Active'], ['2026-11-05T07:00:00Z', 'Finalizing tickets…']]) {
        const html = compiled.exports.render({ ...raffle, state: 'active', completion_reason: null, selected_outcome: null, ends_at: end });
        assert.match(html, new RegExp(text));
        assert.doesNotMatch(html, /is-winning-prize/);
    }
});
test('all 20 outcomes and long names remain available without truncation', () => {
    const prizes = Array.from({ length: 20 }, (_, i) => ({ ...raffle.prizes[0], outcome: i + 1, item_id: i + 1, name: `Long prize name with many words ${i + 1}`, probability_bps: 500 }));
    const html = compiled.exports.render({ ...raffle, prizes });
    assert.equal((html.match(/<li\b/g) || []).length, 20);
    assert.doesNotMatch(html, /raffle-prize-scene-many/);
});

test('winner name and displayed ticket appear in the reveal without exposing private totals', () => {
    const html = compiled.exports.render({ ...raffle, winner_player_id: 123 }, new Map(), { winner_name: 'Lucky Player', profile_id: 'profile-id', winning_ticket: '8888' });
    assert.match(html, /Lucky Player/);
    assert.match(html, /href="\/seller\/profile-id"/);
    assert.match(html, /#8,888/);
    assert.match(html, /raffle-showcase-footer/);
    assert.doesNotMatch(html, /ticket_count|draw_result|revenue/);
});

test('complete entries follow a balanced outward-and-back arc within the prize area', () => {
    const html = compiled.exports.render(raffle);
    const entries = html.match(/<li\b[\s\S]*?<\/li>/g);
    const offsets = entries.map(entry => {
        for (const text of ['raffle-prize-icon','raffle-prize-description','x ','% chance']) assert.ok(entry.includes(text));
        return ['prize-x','prize-y'].map(key => Number(entry.match(new RegExp(`--${key}:([0-9.]+)%`))[1]));
    });
    const [top, middle, bottom] = offsets;
    assert.ok(middle[0] > top[0]);
    assert.ok(middle[0] > bottom[0]);
    assert.ok(bottom[0] > top[0]);
    assert.ok(top[0] < middle[0] && middle[0] > 25 && bottom[0] > 25);
    assert.ok(bottom[0] < middle[0]);
    assert.ok(top[1] > 5 && bottom[1] < 89);
    assert.ok(top[1] > 5 && middle[1] > top[1] && bottom[1] < 89);
});

test('smaller prize pools stay centered and close, with no unnecessary added card height', () => {
    for (const count of [1, 2]) {
        const html = compiled.exports.render({ ...raffle, prizes: raffle.prizes.slice(0, count) });
        assert.match(html, /--scene-height:340px/);
        const rows = html.match(/<li\b[\s\S]*?<\/li>/g);
        assert.equal(rows.length, count);
        if (count === 1) assert.equal(rows.length, 1);
        else { assert.doesNotMatch(rows[0], /--prize-y:5%/); assert.doesNotMatch(rows[1], /--prize-y:89%/); }
    }
});
test('long labels use natural-height entries rather than overlapping the arc', () => {
    const html = compiled.exports.render({ ...raffle, prizes: raffle.prizes.map(p => ({ ...p, name: 'An especially long item name that needs multiple lines' })) });
    assert.doesNotMatch(html, /raffle-prize-scene-many/);
});

test('prize range beneath heading shows compact minimum and maximum total prize values', () => {
    const html = compiled.exports.render({ ...raffle, state: 'active', selected_outcome: null, completion_reason: null }, new Map([[1, { available: true, price_meat: 100 }], [2, { available: true, price_meat: 800 }], [3, { available: true, price_meat: 1240000000 }]]));
    assert.match(html, /Ranging from 100 to 1.24b meat/);
    assert.match(html, /raffle-prize-value-range/);
    assert.ok(html.indexOf('Ranging from') > html.indexOf('</h3>'));
    assert.ok(html.indexOf('Ranging from') < html.indexOf('class="raffle-prize-scene"'));
    assert.doesNotMatch(html.match(/<h3[\s\S]*?<\/h3>/)[0], /Ranging from/);
    const quantityRange = compiled.exports.render({ ...raffle, state: 'active', selected_outcome: null, completion_reason: null }, new Map([[1, { available: true, price_meat: 1000 }], [2, { available: true, price_meat: 500 }], [3, { available: true, price_meat: 100 }]]));
    assert.match(quantityRange, /Ranging from 100 to 1.5k meat/);
    assert.match(compiled.exports.render(raffle), /Prize range unavailable\./);
});

test('concluded range uses its snapshot and never falls back to live market values', () => {
    const prices = new Map(raffle.prizes.map(p => [p.item_id, { available: true, price_meat: 999999 }]));
    assert.match(compiled.exports.render({ ...raffle, prize_range_min: '100', prize_range_max: '200', prize_range_frozen_at: '2026-11-05' }, prices), /Ranging from 100 to 200 meat/);
    assert.match(compiled.exports.render(raffle, prices), /Prize range unavailable/);
});
