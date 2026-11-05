import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRaffleTickets } from '../src/lib/raffleTickets.js';
test('personal ticket counts use compact lowercase notation', () => {
    for (const [count, expected] of [[0,'0'], [1,'1'], [29,'29'], [195,'195'], [1200,'1.2k'], [10000,'10k'], [452000,'452k'], [1000000,'1m'], [999999,'1m']]) assert.equal(formatRaffleTickets(count), expected);
});
