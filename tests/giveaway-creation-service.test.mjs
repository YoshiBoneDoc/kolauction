import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionService } from '../src/lib/auctions.js';

test('one-hour Giveaway reuses the existing custom-end RPC without changing ordinary presets', async () => {
    const calls = [];
    const service = createAuctionService({ rpc: async (name, args) => { calls.push({ name, args }); return { data: 'id' }; } });
    const base = { item: 'dense meat stack', itemId: 258, quantity: 1000, minBidMeat: 1, escrowMode: true, giveawayTitle: 'Meat Stack Mania', giveawayWinCondition: 'split', auctionTime: '1', customEndAt: '2026-11-05T12:00:00Z' };
    await service.create(base);
    assert.equal(calls[0].name, 'create_giveaway_auction');
    assert.equal(calls[0].args.p_duration_hours, 6);
    assert.equal(calls[0].args.p_custom_end_at, base.customEndAt);
    assert.equal(calls[0].args.p_win_condition, 'split');
    await service.create({ ...base, auctionTime: '12', customEndAt: undefined });
    assert.equal(calls[1].args.p_duration_hours, 12);
    assert.equal(calls[1].args.p_custom_end_at, undefined);
});
