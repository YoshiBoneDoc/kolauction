import test from 'node:test';
import assert from 'node:assert/strict';
import { KolTransport } from '../src/transport.mjs';
import { EscrowWorker } from '../src/worker.mjs';
import { closetIncome } from '../src/closet.mjs';
import { assertSolvent } from '../src/protocol.mjs';

const now = 1800000000000;
test('transfer pause uses the game rollover timestamp and a two-minute buffer', () => {
    const transport = new KolTransport('kHub', '', {});
    transport.nextRollover = now + 121000;
    assert.equal(transport.transfersAllowed(now), true);
    assert.equal(transport.transfersAllowed(now + 1000), false);
    assert.equal(transport.transfersAllowed(now + 240000), false);
    transport.nextRollover = now + 86400000;
    assert.equal(transport.transfersAllowed(now + 240000), true);
});

test('maintenance detection prevents writes even if the cached timestamp is far away', () => {
    const transport = new KolTransport('kHub', '', { isRollover: () => true });
    transport.nextRollover = now + 86400000;
    assert.equal(transport.transfersAllowed(now), false);
});

test('an API session surviving rollover refreshes main.php and resumes with a new deadline', async t => {
    let clock = now;
    t.mock.method(Date, 'now', () => clock);
    const deadline = now + 180000;
    let refreshed = false;
    const calls = [];
    const client = {
        async fetchStatus() {
            calls.push('status');
            return { playerid: '3888760', hardcore: false, roninleft: 0, meat: 1000,
                rollover: (deadline + (refreshed ? 86400000 : 0)) / 1000 };
        },
        async fetchText(path, options) {
            calls.push(path);
            assert.equal(path, 'main.php');
            assert.equal(options.method, 'GET');
            assert.equal(options.retry, 0);
            assert.equal(options.body, undefined);
            assert.equal(options.query, undefined);
            refreshed = true;
            return 'Game is available';
        },
        async fetchJson() { return []; },
        isRollover: () => false,
    };
    const transport = new KolTransport('kHub', '', client, () => {});
    await transport.snapshot();
    clock = deadline - 120000;
    await transport.snapshot();
    assert.equal(transport.transfersAllowed(), false);
    assert.ok(!calls.includes('main.php'), 'do not refresh the session before rollover');
    clock = deadline + 420000;
    await transport.snapshot();
    assert.equal(transport.transfersAllowed(), true);
    assert.equal(transport.nextRollover, deadline + 86400000);
    assert.deepEqual(calls.slice(-3), ['status', 'main.php', 'status']);
});

test('an expired deadline stays paused and session refreshes are limited to once per minute', async t => {
    let clock = now;
    t.mock.method(Date, 'now', () => clock);
    let refreshes = 0;
    const transport = new KolTransport('kHub', '', {
        async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0, rollover: (now - 300000) / 1000 }; },
        async fetchText() { refreshes++; return 'Game page'; },
    }, () => {});
    await transport.identity();
    assert.equal(transport.transfersAllowed(), false);
    assert.equal(refreshes, 1);
    clock += 59000;
    await transport.identity();
    assert.equal(refreshes, 1);
    clock += 1000;
    await transport.identity();
    assert.equal(refreshes, 2);
    assert.equal(transport.transfersAllowed(), false);
});

test('post-rollover refresh failure stays paused without exposing session errors', async t => {
    t.mock.method(Date, 'now', () => now);
    const logs = [];
    const transport = new KolTransport('kHub', '', {
        async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0, rollover: (now - 300000) / 1000 }; },
        async fetchText() { throw new Error('main.php?pwd=private-session-secret'); },
    }, line => logs.push(line));
    await assert.rejects(transport.identity(), error => {
        assert.match(error.message, /post-rollover session refresh failed/);
        assert.ok(!error.message.includes('private-session-secret'));
        return true;
    });
    assert.equal(transport.transfersAllowed(), false);
    assert.ok(!logs.join('').includes('private-session-secret'));
});

test('status after a rollover refresh must still verify the bot identity and restrictions', async t => {
    t.mock.method(Date, 'now', () => now);
    for (const [invalid, message] of [[{ playerid: '123' }, /Wrong KoL account/], [{ hardcore: true }, /out of Hardcore/]]) {
        let refreshed = false;
        const transport = new KolTransport('kHub', '', {
            async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0,
                rollover: (now + (refreshed ? 86400000 : -300000)) / 1000, ...(refreshed ? invalid : {}) }; },
            async fetchText() { refreshed = true; return 'Game page'; },
        }, () => {});
        await assert.rejects(transport.identity(), message);
        assert.equal(transport.transfersAllowed(), false);
    }
});

test('startup waits through detected rollover and logs in after the game returns', async () => {
    const calls = []; let attempts = 0;
    const client = {
        async login() { calls.push('login'); return ++attempts > 1; },
        isRollover: () => attempts === 1,
        async waitForRolloverEnd() { calls.push('wait'); },
        async fetchStatus() { calls.push('identity'); return { playerid: '3888760', hardcore: false, roninleft: 0, rollover: Math.floor(now / 1000) + 86400 }; },
    };
    const transport = new KolTransport('kHub', '', client, () => {});
    await transport.connect();
    assert.deepEqual(calls, ['login', 'wait', 'login', 'identity']);
    assert.equal(transport.nextRollover, now + 86400000);
});

test('failed login outside maintenance is still a visible error', async () => {
    const transport = new KolTransport('kHub', '', { async login() { return false; }, isRollover: () => false });
    await assert.rejects(transport.connect(), /login failed/);
});

test('worker records intake but claims no transfers or deletions near rollover, then resumes next cycle', async () => {
    const calls = []; const logs = []; let allowed = false;
    const store = { async rpc(name) {
        calls.push(name);
        if (name === 'bot_inspect') return { attention: [], closetAttention: [] };
        if (name === 'bot_liabilities') return { meat: '1000', items: {} };
        if (name === 'bot_mail_cleanup') return ['90'];
        return null;
    } };
    const transport = {
        async inbox() { return [{ id: '90', command: { type: 'bid' }, meat: 1000, items: [], raw: { type: 'normal' } }]; },
        async snapshot() { return { meat: '1000', items: {} }; },
        transfersAllowed: () => allowed,
        async closetSnapshot() { return { meat: '1000', items: {}, closetMeat: '0', closetItems: {} }; },
        async acknowledge() { calls.push('delete'); },
    };
    const worker = new EscrowWorker({ store, transport, live: true, log: line => logs.push(line) });
    assert.equal(worker.reserve, 0);
    await worker.cycle();
    assert.ok(calls.includes('bot_ingest_mail'));
    assert.ok(!calls.includes('bot_claim_delivery') && !calls.includes('bot_claim_closet_transfer') && !calls.includes('delete'));
    allowed = true;
    await worker.cycle();
    assert.ok(calls.includes('bot_claim_delivery') && calls.includes('bot_claim_closet_transfer') && calls.includes('delete'));
    assert.equal(logs.filter(line => line.includes('rollover pause ended')).length, 1);
    await worker.cycle();
    assert.equal(logs.filter(line => line.includes('rollover pause ended')).length, 1, 'announce resumption only once');
});

test('review notices wait before a durable claim during the rollover buffer', async () => {
    const worker = new EscrowWorker({ live: true, log: () => {}, store: { async rpc() { assert.fail('must not claim'); } },
        transport: { async prepareTransfers() { return false; } } });
    await worker.notifyManualReview();
});

test('closet planner and claims wait during maintenance', async () => {
    await closetIncome({ reserve: 0, pause: async () => {}, log: () => {},
        store: { async rpc() { assert.fail('must not plan or claim'); } },
        transport: { async closetSnapshot() { return { meat: '1000', items: {}, closetMeat: '0', closetItems: {} }; }, transfersAllowed: () => false } });
});

test('zero optional buffer still protects every escrow obligation', () => {
    assertSolvent({ meat: '1000', items: { 1: 2 } }, { meat: '1000', items: { 1: '2' } }, 0);
    assert.throws(() => assertSolvent({ meat: '999', items: { 1: 2 } }, { meat: '1000', items: { 1: '2' } }, 0), /Meat/);
    assert.throws(() => assertSolvent({ meat: '1000', items: { 1: 1 } }, { meat: '1000', items: { 1: '2' } }, 0), /Item/);
});
