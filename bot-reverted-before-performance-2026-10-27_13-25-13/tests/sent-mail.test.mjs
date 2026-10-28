import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSentPage, matchSentDelivery } from '../src/sent-mail.mjs';
import { KolTransport } from '../src/transport.mjs';
import { EscrowWorker } from '../src/worker.mjs';

const id = '00000000-0000-0000-0000-000000000066';
const delivery = { id, recipient_id: 888, attempt: 'attempt-one', delivery_reference: 'D-1080',
    reference_marker: 'Reference: D-1080', expected_message: 'You won!\n\nAuction #1011\nCandy × 1\n\nReference: D-1080' };
const page = (messages, pagination = 'Messages: Sent, page 1 (1 messages)') => `<html><b>${pagination}</b><table>${messages}</table></html>`;
const message = ({ mid = '7654321', recipient = '888', body = delivery.expected_message.replace(/\n/g, '<br>'), extraHeader = '' } = {}) =>
    `<tr><td valign=top><input type=checkbox name="sel${mid}"><b>To:</b> <a href="showplayer.php?who=${recipient}">Player</a>${extraHeader}<br>Date: Thursday, October 22, 2026, 12:00AM<br><blockquote>${body}</blockquote></td></tr>`;

test('exact saved message and recipient yield the actual KoL sent-message ID', () => {
    const parsed = parseSentPage(page(message()));
    assert.equal(parsed.next, null);
    const match = matchSentDelivery(delivery, parsed.messages);
    assert.equal(match.status, 'verified'); assert.equal(match.message_id, '7654321');
    assert.match(match.message_hash, /^[a-f0-9]{64}$/);
});
test('reference alone, wrong recipient, quoted content and duplicate copies never prove success', () => {
    for (const html of [message({ recipient: '999' }), message({ body: `Someone quoted ${delivery.expected_message}` }),
        message() + message({ mid: '7654322' })]) {
        assert.equal(matchSentDelivery(delivery, parseSentPage(page(html)).messages).status, 'ambiguous');
    }
    const longer = message({ body: delivery.expected_message.replaceAll('D-1080', 'D-10800') });
    assert.equal(matchSentDelivery(delivery, parseSentPage(page(longer)).messages).status, 'not_found');
    const forged = message({ recipient: '999', body: `To: <a href="showplayer.php?who=888">Player</a>${delivery.expected_message}` });
    assert.equal(matchSentDelivery(delivery, parseSentPage(page(forged)).messages).status, 'ambiguous');
});
test('HTML entities, line wrapping and legacy UUID markers compare without revealing bodies', () => {
    const d = { ...delivery, expected_message: 'Item &lt;name&gt; &amp; Meat\nReference: D-1080' };
    assert.equal(matchSentDelivery(d, parseSentPage(page(message({ body: 'Item &lt;name&gt; &amp; Meat<br>Reference: D-1080' }))).messages).status, 'verified');
    const old = { ...delivery, reference_marker: `[kHub delivery ${id}]`, expected_message: `Old payout\n[kHub delivery ${id}]` };
    assert.equal(matchSentDelivery(old, parseSentPage(page(message({ body: old.expected_message }))).messages).status, 'verified');
});
test('visible sent-copy attachments must match the recorded items and Meat', () => {
    const d = { ...delivery, item_id: 2, quantity: 3, meat: 1000 };
    const suffix = '<center>You lose 1,000 Meat</center><table class="item" rel="id=2&n=3"><tr><td>Candy</td></tr></table>';
    const parsed = parseSentPage(page(message({ body: delivery.expected_message.replace(/\n/g, '<br>') + suffix })));
    assert.equal(matchSentDelivery(d, parsed.messages).status, 'verified');
    assert.equal(matchSentDelivery({ ...d, quantity: 2 }, parsed.messages).status, 'ambiguous');
    assert.equal(matchSentDelivery({ ...d, meat: 999 }, parsed.messages).status, 'ambiguous');
});
test('login pages and unknown page structure cannot become successful evidence', () => {
    for (const html of ['<form>Log in</form>', '<b>Messages: Inbox, page 1 (1 messages)</b>', '<b>Messages: Sent</b>']) {
        assert.throws(() => parseSentPage(html));
    }
    assert.deepEqual(parseSentPage('There are no messages in this mailbox.'), { messages: [], next: null });
});
test('Sent Mail reads are bounded GETs; copy can be found on later pages without any send/delete', async () => {
    const requests = [];
    const session = Object.assign(() => assert.fail('raw read required'), { async raw(path, options) {
        requests.push({ path, options });
        return { status: 200, _data: requests.length === 1
            ? page(message({ mid: '7654319', body: 'Unrelated note' }), 'Messages: Sent, page 1 (1 - 1 of 2)')
            : page(message(), 'Messages: Sent, page 2 (2 - 2 of 2)') };
    } });
    const transport = new KolTransport('kHub', '', { session, async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0 }; } });
    transport.needsGameInitialization = false;
    const results = await transport.findSentDeliveries([delivery]);
    assert.equal(results[0].status, 'verified'); assert.equal(requests.length, 2);
    for (const { path, options } of requests) {
        assert.equal(path, 'messages.php'); assert.equal(options.method, 'GET');
        assert.equal(options.query.box, 'Sent'); assert.equal(options.retry, 0);
        assert.equal(options.redirect, 'manual'); assert.equal(options.body, undefined);
    }
});
test('read errors never imply not-sent and preserve candidate IDs for manual investigation', async () => {
    let reads = 0;
    const session = Object.assign(() => assert.fail(), { async raw() {
        if (++reads === 2) throw Error('private-cookie-and-body');
        return { status: 200, _data: page(message(), 'Messages: Sent, page 1 (1 - 1 of 2)') };
    } });
    const transport = new KolTransport('kHub', '', { session, async fetchStatus() { return { playerid: '3888760' }; } });
    transport.needsGameInitialization = false;
    const results = await transport.findSentDeliveries([delivery]);
    assert.equal(results[0].status, 'check_failed'); assert.deepEqual(results[0].candidate_ids, ['7654321']);
    assert.ok(!JSON.stringify(results).includes('private-cookie'));
});

function workerFixture(status) {
    const calls = []; const row = { ...delivery, state: 'unknown', kind: 'sale_meat', meat: '100', item_id: null, quantity: 0 };
    let isolated = false; let notified = 0;
    const store = { async rpc(name, args) {
        calls.push([name, args]);
        if (name === 'bot_inspect') return { mailboxRecoveryEnabled: true, attention: row.state === 'unknown' ? [row] : [],
            isolatedDeliveryAttention: isolated ? [row] : [] };
        if (name === 'bot_mailbox_check_deliveries') return row.state === 'unknown' ? [row] : [];
        if (name === 'bot_record_mailbox_check') {
            if (status === 'verified') { row.state = 'sent'; return { status: 'sent', message_id: '7654321' }; }
            if (!isolated) notified++; isolated = true; return { status: 'isolated' };
        }
        if (name === 'bot_dispatch_liabilities') return { meat: '0', items: {} };
        if (name === 'bot_claim_delivery') return null;
        if (name === 'bot_claim_closet_transfer') return null;
        if (name === 'bot_liabilities') return { meat: '0', items: {} };
    } };
    const transport = { async findSentDeliveries() { calls.push(['sent-mail-read']); return [{ id, status, candidate_ids: [] }]; },
        async inbox() { calls.push(['inbox']); return []; }, async snapshot() { return { meat: '0', items: {} }; },
        async closetSnapshot() { calls.push(['closet']); return { meat: '0', closetMeat: '0', items: {}, closetItems: {} }; },
        async send() { assert.fail('uncertain delivery must never be resent'); } };
    const worker = new EscrowWorker({ store, transport, live: true, log: () => {} });
    return { worker, row, calls, notices: () => notified };
}
for (const status of ['verified', 'not_found', 'ambiguous', 'check_failed']) test(`worker recovers ${status} and continues the normal queue without resending`, async () => {
    const f = workerFixture(status);
    await f.worker.cycle();
    assert.ok(f.calls.some(([name]) => name === 'bot_claim_delivery'));
    assert.ok(f.calls.some(([name]) => name === 'inbox'));
    if (status === 'verified') assert.equal(f.row.state, 'sent');
    else {
        assert.equal(f.row.state, 'unknown'); assert.equal(f.notices(), 1);
        assert.ok(!f.calls.some(([name]) => name === 'closet'));
        await f.worker.cycle();
        assert.equal(f.calls.filter(([name]) => name === 'sent-mail-read').length, 1, 'do not hammer Sent Mail every cycle');
    }
});

test('a timeout during this cycle isolates that delivery and sends the next one', async () => {
    const f = workerFixture('not_found');
    f.row.state = 'pending';
    let sent = 0; let nextClaimed = false;
    const rpc = f.worker.store.rpc;
    f.worker.store.rpc = async (name, args) => {
        if (name === 'bot_claim_delivery') {
            f.calls.push([name, args]);
            if (f.row.state === 'pending') { f.row.state = 'sending'; return { ...f.row }; }
            if (!nextClaimed) { nextClaimed = true; return { ...f.row, id: '00000000-0000-0000-0000-000000000067', state: 'sending' }; }
            return null;
        }
        if (name === 'bot_ack_delivery') { if (args.p_id === id) f.row.state = 'unknown'; return; }
        return rpc(name, args);
    };
    f.worker.transport.send = async () => { if (++sent === 1) throw Error('Timed out after submitting the transfer'); return 'Confirmed second delivery'; };
    await f.worker.cycle();
    assert.equal(sent, 2); assert.equal(f.row.state, 'unknown'); assert.equal(f.notices(), 1);
    assert.ok(nextClaimed); assert.ok(!f.calls.some(([name]) => name === 'closet'));
});
