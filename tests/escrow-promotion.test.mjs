import test from 'node:test';
import assert from 'node:assert/strict';
import { createEscrowPromotionService, promotionalPreviewFee } from '../src/lib/escrowPromotion.js';

function fixture() {
    const calls = [], events = new Map(); let auth;
    const client = { rpc() { return new Promise(resolve => calls.push(resolve)); },
        auth: { onAuthStateChange(callback) { auth = callback; return { data: { subscription: { unsubscribe() {} } } }; } } };
    const service = createEscrowPromotionService(client, { addEventListener: (k, f) => events.set(k, f), removeEventListener: k => events.delete(k) });
    return { service, calls, events, auth: (id) => auth('SIGNED_IN', id ? { user: { id } } : null) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const data = volume => ({ data: { enabled: true, volume }, error: null });

test('mounted consumers share one metadata read and focus listener; no background polling', async () => {
    const f = fixture();
    const a = f.service.activate('a'), b = f.service.activate('a');
    await tick(); assert.equal(f.calls.length, 1); assert.equal(f.events.size, 1);
    f.calls[0](data('19000000')); await tick();
    await f.service.refresh(); assert.equal(f.calls.length, 1);
    f.events.get('focus')(); await tick(); assert.equal(f.calls.length, 2);
    a(); b(); assert.equal(f.events.size, 0);
});

test('account changes and sign-out discard in-flight responses and previous private volume', async () => {
    const f = fixture(), stop = f.service.activate('a'); await tick();
    f.auth('b'); await tick();
    f.calls[0](data('999999999')); await tick();
    assert.deepEqual(f.service.getSnapshot(), { scope: 'b', data: null });
    f.calls[1](data('123')); await tick(); assert.equal(f.service.getSnapshot().data.volume, '123');
    f.auth(null); assert.deepEqual(f.service.getSnapshot(), { scope: null, data: null });
    stop();
});

test('a toggle invalidates cached eligibility and old in-flight reads', async () => {
    const f = fixture(), stop = f.service.activate('a'); await tick();
    f.service.invalidate(); await tick();
    f.calls[0](data('0')); f.calls[1]({ data: { enabled: false, volume: '20000000' } }); await tick();
    assert.equal(f.service.getSnapshot().data.enabled, false); stop();
});

test('preview uses the entire transaction and exact promotional marginal rates', () => {
    assert.equal(promotionalPreviewFee(1000000000, { enabled: true, volume: '19999999' }), 0);
    assert.equal(promotionalPreviewFee(2000000000, { enabled: true, volume: '20000000' }), 30000000);
    assert.equal(promotionalPreviewFee(49, { enabled: true, volume: '20000000' }), 0);
    assert.equal(promotionalPreviewFee(100, null), null);
});
