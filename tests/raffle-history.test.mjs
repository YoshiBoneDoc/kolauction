import test from 'node:test';
import assert from 'node:assert/strict';
import { raffleHistoryStatus } from '../src/lib/raffleHistory.js';
test('history distinguishes active time, awaiting draws, winner delivery, losses and canceled refunds', () => {
    const active = { state: 'active', ends_at: '2030-01-01T00:00:00Z', won: null };
    assert.equal(raffleHistoryStatus(active, 0), 'Active');
    assert.equal(raffleHistoryStatus(active, Date.parse(active.ends_at)), 'Finalizing draw');
    assert.equal(raffleHistoryStatus({ state: 'drawing', won: null }, 0), 'Finalizing draw');
    assert.equal(raffleHistoryStatus({ state: 'fulfilling', won: true }, 0), 'Won · prize delivery pending');
    assert.equal(raffleHistoryStatus({ state: 'settled', won: true }, 0), 'Won · concluded');
    assert.equal(raffleHistoryStatus({ state: 'settled', won: false }, 0), 'Not selected');
    assert.equal(raffleHistoryStatus({ state: 'returning', completion_reason: 'cancelled', won: null }, 0), 'Canceled · ticket refund');
});
