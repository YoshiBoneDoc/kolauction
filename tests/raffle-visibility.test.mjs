import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewRaffles } from '../src/lib/raffleVisibility.js';

test('raffle access requires server authorization rather than former tester identities', () => {
    for (const user of [null, {}, { kolPlayerId: 3552305 }, { kolPlayerName: 'anrath1' }, { kolPlayerName: 'nisemono' }, { isAdmin: true }]) {
        assert.equal(canViewRaffles(user), false);
    }
    assert.equal(canViewRaffles({ canViewRaffles: true }), true);
    assert.equal(canViewRaffles({ canViewRaffles: true, isBanned: true }), false);
});
