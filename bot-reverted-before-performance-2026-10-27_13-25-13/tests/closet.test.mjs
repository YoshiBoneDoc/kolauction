import test from 'node:test';
import assert from 'node:assert/strict';
import { closetIncome, ClosetTransferError } from '../src/closet.mjs';
import { KolTransport } from '../src/transport.mjs';
import { normalizeMail } from '../src/protocol.mjs';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';
import { ofetch } from 'ofetch';
import makeFetchCookie from 'fetch-cookie';

const id = '00000000-0000-0000-0000-000000000013';
const operation = { id, attempt: 'attempt', closet_reference: 'C-1001', source: 'donation',
    meat: 750, item_id: null, quantity: 0, before_state: { inventory: '5000', closet: '1000' } };

for (const item of [false, true]) test(`closet ${item ? 'items' : 'Meat'} uses one raw write and confirms actual closet balances`, async () => {
    let request;
    const client = { async session(path, options) { request = { path, ...options }; return 'result'; } };
    const transport = new KolTransport('kHub', '', client);
    transport.closetSnapshot = async () => item
        ? { meat: '0', closetMeat: '0', items: { 1: '7' }, closetItems: { 1: '8' } }
        : { meat: '4250', closetMeat: '1750', items: {}, closetItems: {} };
    const move = item ? { ...operation, meat: 0, item_id: 1, quantity: 3, before_state: { inventory: '10', closet: '5' } } : operation;
    const evidence = await transport.depositCloset(move);
    assert.equal(request.path, item ? 'fillcloset.php' : 'closet.php');
    assert.equal(request.retry, 0); assert.equal(request.redirect, 'manual');
    assert.equal(request.method, item ? 'GET' : 'POST');
    if (item) {
        assert.equal(request.body, undefined);
        assert.deepEqual(request.query, { action: 'closetpush', whichitem: '1', qty: '3', ajax: '1' });
    } else {
        assert.equal(request.body.get('action'), 'addtakeclosetmeat');
        assert.equal(request.body.get('quantity'), '750');
    }
    assert.match(evidence, /before/); assert.match(evidence, /after/);
});

test('a successful-looking response without the exact closet increase is uncertain', async () => {
    let writes = 0;
    const transport = new KolTransport('kHub', '', { async session() { writes++; return 'in your closet'; } });
    transport.closetSnapshot = async () => ({ meat: '5000', closetMeat: '1000', items: {}, closetItems: {} });
    await assert.rejects(transport.depositCloset(operation), error => {
        assert.equal(error.diagnostic.stage, 'balance_mismatch');
        assert.deepEqual(error.diagnostic.after, { inventory: '5000', closet: '1000' });
        assert.equal(error.diagnostic.expected.closet, '1750');
        return true;
    });
    assert.equal(writes, 1);
});

test('a closet redirect is never followed or retried and requires balance confirmation', async () => {
    for (const moved of [true, false]) {
        let requests = 0;
        const session = ofetch.create({ baseURL: 'https://www.kingdomofloathing.com' }, { fetch: makeFetchCookie(async () => {
            requests++;
            return new Response('', { status: 302, headers: { location: 'https://www.kingdomofloathing.com/inventory.php?pwd=private-session-token' } });
        }) });
        const transport = new KolTransport('kHub', '', { session });
        transport.closetSnapshot = async () => ({ meat: moved ? '4250' : '5000', closetMeat: moved ? '1750' : '1000', items: {}, closetItems: {} });
        if (moved) await transport.depositCloset(operation);
        else await assert.rejects(transport.depositCloset(operation), error => {
            assert.equal(error.diagnostic.stage, 'balance_mismatch');
            assert.equal(error.diagnostic.httpStatus, 302);
            assert.equal(error.diagnostic.redirectPath, '/inventory.php');
            assert.ok(!JSON.stringify(error.diagnostic).includes('private-session-token'));
            return true;
        });
        assert.equal(requests, 1);
    }
});

test('new incoming Meat can arrive while a confirmed closet deposit finishes', async () => {
    const transport = new KolTransport('kHub', '', { async session() { return 'result'; } });
    transport.closetSnapshot = async () => ({ meat: '7000', closetMeat: '1750', items: {}, closetItems: {} });
    await transport.depositCloset(operation);
});

test('closet diagnosis reads pages without submitting actions or exposing field values', async () => {
    const paths = [];
    const session = Object.assign(() => assert.fail('must use raw read'), { async raw(path, options) {
        paths.push(path);
        assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
        assert.equal(options.retry, 0); assert.equal(options.body, undefined); assert.equal(options.query, undefined);
        return { status: 302, headers: new Headers({ location: 'https://www.kingdomofloathing.com/choice.php?pwd=secret-token&whichchoice=1' }),
            _data: '<form action="fillcloset.php?pwd=secret-token" method="post"><input name="pwd" value="secret-token"><input name="action" value="closetpush"><input name="whichitem" value="1904"><input name="qty" value="1"></form>' };
    } });
    const result = await new KolTransport('kHub', '', { session }).diagnoseCloset();
    assert.deepEqual(paths, ['closet.php', 'fillcloset.php', 'inventory.php']);
    assert.equal(result.pages[0].redirectPath, '/choice.php');
    assert.deepEqual(result.pages[0].forms[0], { action: '/fillcloset.php', method: 'POST', fields: ['pwd', 'action', 'whichitem', 'qty'], actions: ['closetpush'] });
    assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('login initializes main.php before ordinary pages and repeats initialization after relogin', async () => {
    const calls = []; let ready = false; let onLogin;
    const session = Object.assign(() => assert.fail('must use raw reads'), { async raw(path, options) {
        calls.push(path);
        assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.retry, 0);
        assert.equal(options.query, undefined); assert.equal(options.body, undefined);
        if (path === 'main.php') ready = true;
        return { status: ready ? 200 : 302, headers: new Headers(ready ? {} : { location: 'main.php' }), _data: '' };
    } });
    const client = { session, on(event, handler) { assert.equal(event, 'login'); onLogin = handler; },
        async login() { onLogin(); return true; },
        async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0 }; } };
    const transport = new KolTransport('kHub', '', client);
    await transport.connect();
    assert.deepEqual(calls, ['main.php']);
    assert.ok((await transport.diagnoseCloset()).pages.every(page => page.httpStatus === 200));
    await transport.identity();
    assert.equal(calls.filter(path => path === 'main.php').length, 1);
    ready = false; onLogin();
    await transport.identity();
    assert.equal(calls.filter(path => path === 'main.php').length, 2);
});

test('failed main-page initialization prevents a usable connection', async () => {
    const session = Object.assign(() => {}, { async raw() { return { status: 302 }; } });
    const client = { session, async login() { return true; }, async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0 }; } };
    await assert.rejects(new KolTransport('kHub', '', client).connect(), /initialization returned HTTP 302/);
});

test('malformed closet transfers are rejected before making a write', async () => {
    const transport = new KolTransport('kHub', '', { async session() { assert.fail('must not write'); } });
    for (const bad of [{ ...operation, meat: 0 }, { ...operation, meat: -1 }, { ...operation, item_id: 1, quantity: 2 },
        { ...operation, before_state: null }]) await assert.rejects(transport.depositCloset(bad));
});

test('closet snapshot reads raw closet Meat and accepts empty item arrays', async () => {
    const client = { async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0 }; },
        async fetchJson(path, { query }) { return query.what === 'status'
            ? { playerid: '3888760', hardcore: '0', roninleft: '0', meat: '4000', closetmeat: '2000' } : []; } };
    const transport = new KolTransport('kHub', '', client);
    assert.deepEqual(await transport.closetSnapshot(), { meat: '4000', closetMeat: '2000', items: {}, closetItems: {} });
    client.fetchJson = async () => ({ playerid: '123' });
    await assert.rejects(transport.closetSnapshot(), /account/);
});

function fixture({ writeFails = false, ackFails = false } = {}) {
    let state = 'pending'; const calls = [];
    const store = { async rpc(name, args) {
        calls.push([name, args]);
        if (name === 'bot_liabilities') return { meat: '2000', items: {} };
        if (name === 'bot_claim_closet_transfer') {
            if (state === 'moved') return null;
            if (['moving', 'unknown'].includes(state)) throw Error('reconciliation');
            state = 'moving'; return operation;
        }
        if (name === 'bot_ack_closet_transfer') {
            if (ackFails) throw Error('DB unavailable');
            state = args.p_moved ? 'moved' : 'unknown';
        }
    } };
    const transport = {
        reviewHolds: { meat: '100', items: { 2: '3' }, uncertain: false },
        async closetSnapshot() { return { meat: '5000', closetMeat: '1000', items: {}, closetItems: {} }; },
        async depositCloset() { calls.push(['move']); if (writeFails) throw Error('timeout'); return 'verified balances'; },
    };
    return { args: { store, transport, reserve: 1000, pause: async () => {}, log: () => {} }, calls, state: () => state };
}

test('closet claims and review holds are persisted before writing; acknowledgments prevent repeated moves', async () => {
    const f = fixture(); await closetIncome(f.args); await closetIncome(f.args);
    assert.equal(f.state(), 'moved'); assert.equal(f.calls.filter(([n]) => n === 'move').length, 1);
    const claim = f.calls.findIndex(([n]) => n === 'bot_claim_closet_transfer');
    assert.ok(claim < f.calls.findIndex(([n]) => n === 'move'));
    assert.equal(f.calls[claim][1].p_review_meat, '100');
    assert.deepEqual(f.calls[claim][1].p_review_items, { 2: '3' });
});

for (const options of [{ writeFails: true }, { ackFails: true }]) test(`uncertain closet outcome survives restart without another move ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); await assert.rejects(closetIncome(f.args), /reconcil|acknowledgment/);
    assert.ok(['moving', 'unknown'].includes(f.state()));
    await assert.rejects(closetIncome(f.args), /reconciliation/);
    assert.equal(f.calls.filter(([n]) => n === 'move').length, 1);
});

test('unreadable review assets defer closet moves', async () => {
    const f = fixture(); f.args.transport.reviewHolds.uncertain = true;
    await closetIncome(f.args); assert.equal(f.calls.length, 0);
});

test('blank or invalid funded KMail is refunded, while empty chatter is retained', () => {
    const raw = { id: '90', fromid: '888', fromname: 'Donor', azunixtime: '1792411200', type: 'normal' };
    assert.equal(normalizeMail({ ...raw, message: '<center>You gain 50 Meat</center>' }, KmailMailbox.parse).command.type, 'unknown');
    assert.equal(normalizeMail({ ...raw, message: ' \t ' }, KmailMailbox.parse), null);
    assert.equal(normalizeMail({ ...raw, message: 'hello<center>You gain 50 Meat</center>' }, KmailMailbox.parse).command.type, 'unknown');
    assert.equal(normalizeMail({ ...raw, message: '<b>BID 1001</b><center>You gain 50 Meat</center>' }, KmailMailbox.parse).command.type, 'unknown');
    assert.equal(normalizeMail({ ...raw, message: '<br>BID 1001<center>You gain 50 Meat</center>' }, KmailMailbox.parse).command.type, 'unknown');
    assert.equal(normalizeMail({ ...raw, message: '<table class="item" rel="id=1&n=2"><tr><td><img title="seal tooth"></td></tr></table>' }, KmailMailbox.parse).command.type, 'unknown');
});

test('ordinary unknown-mail attachments enter the refund path instead of donation sweeping', async () => {
    const raw = { id: '91', fromid: '888', fromname: 'Player', azunixtime: '1792411200', type: 'normal',
        message: 'please help<center>You gain 25 Meat</center><table class="item" rel="id=1167&n=2"><tr><td><img title="plain brown wrapper"></td></tr></table>' };
    const transport = new KolTransport('kHub', '', { async fetchJson() { return [raw]; } }, () => {});
    const mail = (await transport.inbox())[0];
    assert.equal(mail.command.type, 'unknown');
    assert.equal(mail.meat, 25);
    assert.deepEqual(mail.items, [{ id: 1167, quantity: 2 }]);
    assert.deepEqual(transport.reviewHolds, { meat: '0', items: {}, uncertain: false });
});


test('closet failure diagnostics never expose raw request URLs or session tokens',async()=>{
    const transport=new KolTransport('kHub','',{async session(){throw Error('GET inventory.php?pwd=private-session-token');}});
    await assert.rejects(transport.depositCloset(operation),error=>{
        assert.ok(error instanceof ClosetTransferError);
        assert.equal(error.diagnostic.stage,'request');
        assert.ok(!JSON.stringify(error.diagnostic).includes('private-session-token'));
        return true;
    });
});

test('safe closet balance diagnostics are logged and saved with the uncertain operation',async()=>{
    const f=fixture();const logs=[];f.args.log=value=>logs.push(value);
    f.args.transport.depositCloset=async()=>{throw new ClosetTransferError({stage:'balance_mismatch',before:{inventory:'5000',closet:'1000'},after:{inventory:'5000',closet:'1000'}});};
    await assert.rejects(closetIncome(f.args),/reconciliation/);
    assert.ok(logs.some(line=>line.includes('balance_mismatch')));
    const ack=f.calls.find(([name])=>name==='bot_ack_closet_transfer')[1];
    assert.equal(ack.p_moved,false);assert.match(ack.p_evidence,/balance_mismatch/);
});

test('package planner does not sweep arrivals beyond the processed inbox budget',async()=>{
    const f=fixture();f.args.packageBudget={1167:'2'};
    f.args.transport.closetSnapshot=async()=>({meat:'5000',closetMeat:'1000',items:{1167:'5'},closetItems:{}});
    await closetIncome(f.args);
    assert.deepEqual(f.calls.find(([name])=>name==='bot_queue_gift_packages')[1].p_inventory,{1167:'2'});
});
