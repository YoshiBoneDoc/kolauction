import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedAuctionService, reminderOptions } from '../src/lib/savedAuctions.js';
test('saved auctions read and write only through owner-scoped RPCs and all requested reminder choices exist', async () => {
    const calls = [];
    const service = createSavedAuctionService({ rpc(name, args) {
        calls.push([name, args]);
        return name === 'read_saved_auctions' ? { abortSignal: async () => ({ data: { rows: [{ id: 'auction', reminder_minutes: 0 }] } }) } : Promise.resolve({ error: null });
    } }, () => 'America/New_York');
    assert.deepEqual(reminderOptions.map(([n]) => n), [0,5,15,30,60,360,720,1440]);
    assert.equal((await service.read('auction'))[0].id, 'auction');
    await service.set('auction', true, 15);await service.set('auction', false);
    assert.deepEqual(calls[1], ['set_saved_auction', { p_id: 'auction', p_saved: true, p_minutes: 15, p_time_zone: 'America/New_York' }]);
    assert.deepEqual(calls[2][1], { p_id: 'auction', p_saved: false, p_minutes: 0, p_time_zone: 'America/New_York' });
    await assert.rejects(service.set('auction', true, 7));assert.equal(calls.length, 3);
});
test('unavailable reads are not displayed as empty successful saved lists; errors do not expose database details', async () => {
    const service = createSavedAuctionService({ rpc: () => ({ abortSignal: async () => ({ error: { message: 'private error' } }) }) });
    await assert.rejects(service.read(), { message: 'Saved auctions unavailable.' });
});
