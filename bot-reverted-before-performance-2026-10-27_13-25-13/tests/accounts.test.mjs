import test from 'node:test';
import assert from 'node:assert/strict';
import { authAdminFailure, createStore } from '../src/store.mjs';
import { generateTemporaryPassword, processAccountMail } from '../src/accounts.mjs';
import { parseCommand, normalizeMail } from '../src/protocol.mjs';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';
import { EscrowWorker } from '../src/worker.mjs';

const mail = { id: '500', command: { type: 'register' } };
function fixture(action = 'register', failure = '') {
    let job, user = action === 'credentials' ? { id: 'user-id', email: 'account-id@login.khub.invalid', app_metadata: { previous: 'keep' } } : null;
    const counts = { create: 0, update: 0, finish: 0, deliveries: 0 };
    let failed = false;
    const store = {
        async rpc(name, args) {
            if (name === 'bot_prepare_account_mail') {
                if (!job) job = { state: 'pending', user_id: 'user-id', username: 'Player', mail_id: mail.id,
                    action, login_email: 'account-id@login.khub.invalid', temporary_password: args.p_password };
                return { ...job };
            }
            if (name === 'bot_check_account_job') return { ...job };
            if (name === 'bot_begin_account_attempt') return true;
            if (name === 'bot_finish_account_job') {
                counts.finish++;
                if (failure === 'finish' && !failed) { failed = true; throw Error('database unavailable'); }
                assert.equal(user.app_metadata.khub_account_job, mail.id);
                if (job.state !== 'done') { counts.deliveries++; job.state = 'done'; job.temporary_password = null; }
                return;
            }
            assert.fail(name);
        },
        accountAdmin: {
            async get() {
                if (failure === 'lookup') throw Error('network unavailable');
                return user;
            },
            async create(input) {
                counts.create++;
                assert.equal(input.id, 'user-id'); assert.equal(input.email_confirm, true);
                assert.equal(input.password.length, 16); assert.equal(input.password, job.temporary_password);
                assert.deepEqual(input.user_metadata, { khub_username: 'Player' });
                user = { id: input.id, email: input.email, app_metadata: input.app_metadata };
                if (failure === 'create' && !failed) { failed = true; throw Error('response lost after creation'); }
            },
            async update(id, input) {
                counts.update++;
                assert.equal(id, 'user-id'); assert.equal(input.password, job.temporary_password);
                assert.equal(input.app_metadata.previous, 'keep');
                user = { ...user, app_metadata: input.app_metadata };
                if (failure === 'update' && !failed) { failed = true; throw Error('response lost after update'); }
            },
        },
    };
    return { store, counts };
}

test('registration/recovery command parsing rejects custom names and accepts exact recovery aliases', () => {
    assert.deepEqual(parseCommand(' REGISTER '), { type: 'register' });
    assert.deepEqual(parseCommand('register Teres Minor'), { type: 'register', invalid_format: true });
    assert.deepEqual(parseCommand('credentials'), { type: 'credentials' });
    assert.deepEqual(parseCommand('FORGOT LOGIN'), { type: 'credentials' });
    for (const command of ['CREDENTIALS AnotherPlayer', 'FORGOT LOGIN player']) assert.equal(parseCommand(command).type, 'unknown');
    const raw = { type: 'normal', id: '500', fromid: '12345', fromname: 'Player', azunixtime: '1792411200', message: 'REGISTER Alias' };
    const normalized = normalizeMail(raw, KmailMailbox.parse);
    assert.equal(normalized.sender_id, 12345); assert.deepEqual(normalized.command, { type: 'register', invalid_format: true });
});

for (const action of ['register', 'credentials']) test(`${action} creates one credential delivery across replays`, async () => {
    const f = fixture(action);
    await processAccountMail(f.store, mail); await processAccountMail(f.store, mail);
    assert.equal(f.counts.deliveries, 1);
    assert.equal(f.counts[action === 'register' ? 'create' : 'update'], 1);
});

for (const [action, failure] of [['register','create'], ['register','finish'], ['credentials','update'], ['credentials','finish']]) {
    test(`${action} safely resumes after lost ${failure} acknowledgment`, async () => {
        const f = fixture(action, failure);
        await assert.rejects(processAccountMail(f.store, mail));
        await processAccountMail(f.store, mail);
        assert.equal(f.counts.deliveries, 1);
        assert.equal(f.counts[action === 'register' ? 'create' : 'update'], 1);
    });
}

test('an unavailable Auth lookup cannot trigger account creation or a password reset', async () => {
    const f = fixture('register', 'lookup');
    await assert.rejects(processAccountMail(f.store, mail), /network unavailable/);
    assert.equal(f.counts.create, 0); assert.equal(f.counts.update, 0); assert.equal(f.counts.deliveries, 0);
});

test('read-only mode never provisions accounts or resets passwords', async () => {
    const calls = [];
    const worker = new EscrowWorker({ live: false, log: () => {},
        store: { async rpc(name) { calls.push(name); assert.equal(name, 'bot_inspect'); return { attention: [] }; } },
        transport: { async inbox() { return [{ ...mail, meat: 0, items: [] }]; } } });
    await worker.cycle(); assert.deepEqual(calls, ['bot_inspect']);
});

test('Auth failures expose status and code without leaking API messages or credentials', () => {
    const error = authAdminFailure('account creation', { status: 500, code: 'unexpected_failure',
        message: 'private-password private-email', details: { key: 'private-key' } });
    assert.match(error.message, /HTTP 500; unexpected_failure/);
    assert.doesNotMatch(error.message, /private-/);
    const untrusted = authAdminFailure('password update', { status: 'private-secret', code: 'password=private-secret' });
    assert.match(untrusted.message, /unknown_error/); assert.doesNotMatch(untrusted.message, /private-secret/);
});

test('new temporary passwords survive mail whitespace/underscore formatting without alteration', () => {
    const passwords = Array.from({ length: 100 }, generateTemporaryPassword);
    for (const password of passwords) {
        assert.equal(password.length, 16);
        // Model transformations that can make an unbroken base64url token
        // hard to copy: underscores displayed as spaces and long-word splitting.
        const displayed = password.replaceAll('_', ' ').replace(/([A-Za-z0-9]{20})(?=[A-Za-z0-9])/g, '$1 ');
        assert.equal(displayed, password);
        assert.match(password, /^Kh9![A-Za-z0-9]{12}$/);
        assert.match(password, /[A-Z]/); assert.match(password, /[a-z]/);
        assert.match(password, /[0-9]/); assert.match(password, /[^A-Za-z0-9]/);
    }
    assert.equal(new Set(passwords).size, passwords.length);
});

function deliveryFixture({ failure = 'lookup', pendingReadFails = false, attachedMeat = 0, notificationFails = false, notifyPlayerOnAccountFailure = true } = {}) {
    const requests = [
        { id: '500', command: { type: failure === 'update' ? 'credentials' : 'register' }, meat: attachedMeat, items: [], raw: { type: 'normal' } },
        { id: '501', command: { type: 'register' }, meat: 0, items: [], raw: { type: 'normal' } },
        { id: '502', command: { type: 'bid' }, meat: 100, items: [], raw: { type: 'normal' } },
    ];
    const calls = [], logs = [], jobs = new Map(), users = new Map();
    if (failure === 'update') users.set('user-500', { email: '500@login.invalid', app_metadata: {} });
    let sequence = 0, delivery;
    const fail = (stage, mid) => {
        if (stage === failure && mid === '500') throw Error('private-password private-email private-token');
    };
    const store = {
        async rpc(name, args) {
            calls.push([name, args]);
            if (name === 'bot_inspect') return { attention: [], accountRequestsPending: 1 };
            if (name === 'bot_pending_account_requests') {
                if (pendingReadFails) throw Error('private-token');
                return [requests[0]];
            }
            if (name === 'bot_prepare_account_mail') {
                const mid = args.p_mail.id;
                fail('prepare', mid);
                if (!jobs.has(mid)) jobs.set(mid, { state: 'pending', mail_id: mid, user_id: `user-${mid}`,
                    action: args.p_mail.command.type, username: `Player ${mid}`, login_email: `${mid}@login.invalid`, temporary_password: args.p_password });
                return { ...jobs.get(mid) };
            }
            if (name === 'bot_check_account_job') { fail('check', args.p_mail_id); return { ...jobs.get(args.p_mail_id) }; }
            if (name === 'bot_begin_account_attempt') return true;
            if (name === 'bot_finish_account_job') {
                fail('finish', args.p_mail_id);
                jobs.get(args.p_mail_id).state = 'done';
                return;
            }
            if (name === 'bot_notify_account_failure') {
                if (notificationFails) throw Error('private-notification-token');
                return { status: jobs.has(args.p_mail_id) ? 'queued' : 'unrecorded' };
            }
            if (name === 'bot_tick') { delivery = { id: `payout-${++sequence}`, attempt: 'attempt', kind: 'sale_meat', meat: 100, recipient_id: 888 }; return; }
            if (name === 'bot_liabilities') return { meat: '100', items: {} };
            if (name === 'bot_claim_delivery') { const row = delivery; delivery = null; return row; }
            if (name === 'bot_ack_delivery') return;
            if (name === 'bot_mail_cleanup') return args.p_mail_ids;
            if (['bot_ingest_mail', 'bot_queue_gift_packages', 'bot_claim_review_notice', 'bot_claim_closet_transfer'].includes(name)) return null;
            assert.fail(name);
        },
        accountAdmin: {
            async get(id) { fail('lookup', id.replace('user-', '')); return users.get(id) || null; },
            async create(input) { fail('create', input.id.replace('user-', '')); users.set(input.id, { email: input.email, app_metadata: input.app_metadata }); },
            async update(id, input) { fail('update', id.replace('user-', '')); users.set(id, { ...users.get(id), app_metadata: input.app_metadata }); },
        },
    };
    const transport = {
        async inbox() { return requests; },
        async snapshot() { return { meat: '10000', items: {} }; },
        async closetSnapshot() { return { meat: '10000', items: {}, closetMeat: '0', closetItems: {} }; },
        async send(row) { calls.push(['send', row.id]); return 'confirmed'; },
        async acknowledge(id) { calls.push(['delete', id]); },
    };
    return { worker: new EscrowWorker({ store, transport, live: true, notifyPlayerOnAccountFailure, log: text => logs.push(text) }), calls, logs, jobs,
        recover() { failure = ''; } };
}

for (const failure of ['prepare', 'check', 'lookup', 'create', 'update', 'finish']) {
    test(`persistent account ${failure} failure cannot starve repeated finalization/payouts or other accounts`, async () => {
        const f = deliveryFixture({ failure });
        for (let cycle = 0; cycle < 3; cycle++) await f.worker.cycle();
        assert.equal(f.calls.filter(([name]) => name === 'bot_tick').length, 3);
        assert.equal(f.calls.filter(([name]) => name === 'send').length, 3);
        assert.equal(f.calls.filter(([name]) => name === 'bot_prepare_account_mail').filter(([, args]) => args.p_mail.id === '500').length, 3);
        assert.equal(f.jobs.get('501').state, 'done');
        assert.equal(f.jobs.get('500')?.state || 'unprepared', failure === 'prepare' ? 'unprepared' : 'pending');
        assert.ok(f.calls.some(([name]) => name === 'bot_ingest_mail'));
        assert.ok(!f.calls.some(([name, id]) => name === 'delete' && id === '500'));
        assert.ok(f.calls.filter(([name]) => name === 'bot_mail_cleanup').every(([, args]) => !args.p_mail_ids.includes('500')));
        assert.ok(f.calls.some(([name, id]) => name === 'delete' && id === '501'));
        assert.ok(f.logs.some(text => /account processing deferred; retained for retry/.test(text)));
        assert.doesNotMatch(f.logs.join('\n'), /private-password|private-email|private-token/);
    });
}

test('pending-account queue read failure still permits inbox processing and payouts', async () => {
    const f = deliveryFixture({ pendingReadFails: true });
    await f.worker.cycle();
    assert.ok(f.calls.some(([name]) => name === 'send'));
    assert.equal(f.jobs.get('501').state, 'done');
    assert.match(f.logs.join('\n'), /Pending account requests could not be loaded/);
    assert.doesNotMatch(f.logs.join('\n'), /private-token/);
});

test('repeated account failures queue notification once and use the requested player-notice preference', async () => {
    for (const notifyPlayerOnAccountFailure of [true, false]) {
        const f = deliveryFixture({ notifyPlayerOnAccountFailure });
        for (let n = 0; n < 3; n++) await f.worker.cycle();
        const notices = f.calls.filter(([name]) => name === 'bot_notify_account_failure');
        assert.deepEqual(notices, [['bot_notify_account_failure', { p_mail_id: '500', p_notify_player: notifyPlayerOnAccountFailure }]]);
        assert.equal(f.jobs.get('500').state, 'pending');
        assert.equal(f.calls.filter(([name]) => name === 'send').length, 3);
    }
});

test('a failed notification RPC retries without blocking payouts or deleting the account request', async () => {
    const f = deliveryFixture({ notificationFails: true });
    for (let n = 0; n < 3; n++) await f.worker.cycle();
    assert.equal(f.calls.filter(([name]) => name === 'bot_notify_account_failure').length, 3);
    assert.equal(f.calls.filter(([name]) => name === 'send').length, 3);
    assert.ok(!f.calls.some(([name, id]) => name === 'delete' && id === '500'));
    assert.match(f.logs.join('\n'), /notification was not confirmed/);
    assert.doesNotMatch(f.logs.join('\n'), /private-notification-token/);
});

test('a deferred account later completes once and only then becomes eligible for source cleanup', async () => {
    const f = deliveryFixture();
    await f.worker.cycle();
    assert.equal(f.jobs.get('500').state, 'pending');
    assert.ok(!f.calls.some(([name, id]) => name === 'delete' && id === '500'));
    f.recover();
    await f.worker.cycle();
    await f.worker.cycle();
    assert.equal(f.jobs.get('500').state, 'done');
    assert.equal(f.calls.filter(([name, args]) => name === 'bot_finish_account_job' && args.p_mail_id === '500').length, 1);
    assert.ok(f.calls.some(([name, id]) => name === 'delete' && id === '500'));
    assert.equal(f.calls.filter(([name]) => name === 'send').length, 3);
});

test('unconfirmed account-mail asset intake still stops transfers and preserves source KMail', async () => {
    const f = deliveryFixture({ failure: 'prepare', attachedMeat: 100 });
    await assert.rejects(f.worker.cycle());
    assert.ok(!f.calls.some(([name]) => ['send', 'delete', 'bot_tick', 'bot_claim_closet_transfer'].includes(name)));
});

test('stalled Auth/account RPCs time out without changing financial RPC timeouts', async t => {
    const observed = [];
    // AbortSignal.timeout uses an unreferenced timer; keep this fixture alive
    // while awaiting the deliberately stalled request without a real server.
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url).pathname;
        observed.push({ path, signal: init.signal });
        if (path === '/rest/v1/rpc/bot_tick') return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
        assert.ok(init.signal, `Missing timeout: ${path}`);
        return new Promise((resolve, reject) => {
            const abort = () => reject(init.signal.reason);
            if (init.signal.aborted) abort();
            else init.signal.addEventListener('abort', abort, { once: true });
        });
    });
    const store = createStore('https://example.invalid', 'test-service-key', { accountTimeoutMs: 20 });
    const userId = '00000000-0000-0000-0000-000000000500';
    await assert.rejects(store.accountAdmin.get(userId), /account lookup was not confirmed/);
    await assert.rejects(store.accountAdmin.create({ id: userId, email: 'test@example.invalid', password: 'private-password' }), /account creation was not confirmed/);
    await assert.rejects(store.accountAdmin.update(userId, { password: 'private-password' }), /password update was not confirmed/);
    for (const rpc of ['bot_prepare_account_mail', 'bot_check_account_job', 'bot_finish_account_job', 'bot_pending_account_requests', 'bot_notify_account_failure']) {
        await assert.rejects(store.rpc(rpc), /bot_/);
    }
    assert.equal(await store.rpc('bot_tick'), null);
    assert.equal(observed.length, 9);
    assert.ok(observed.slice(0, -1).every(request => request.signal.aborted));
    assert.equal(observed.at(-1).signal, undefined);
});


test('a durable cooldown prevents inbox replay from contacting Auth', async () => {
    const f = fixture();
    const rpc = f.store.rpc.bind(f.store);
    let lookups = 0;
    f.store.rpc = async (name, args) => name === 'bot_begin_account_attempt' ? false : rpc(name, args);
    f.store.accountAdmin.get = async () => { lookups++; };
    await processAccountMail(f.store, mail);
    await processAccountMail(f.store, mail);
    assert.equal(lookups, 0);
    assert.equal(f.counts.deliveries, 0);
});

test('a large account backlog is bounded while payouts continue and skipped mail stays intact', async () => {
    const f = deliveryFixture();
    const rpc = f.worker.store.rpc.bind(f.worker.store);
    const backlog = Array.from({ length: 100 }, (_, i) => ({ id: String(500 + i), command: { type: 'register' }, meat: 0, items: [] }));
    f.worker.store.rpc = async (name, args) => name === 'bot_pending_account_requests' ? backlog : rpc(name, args);
    await f.worker.cycle();
    assert.equal(f.calls.filter(([name]) => name === 'bot_prepare_account_mail').length, 2);
    assert.equal(f.calls.filter(([name]) => name === 'send').length, 1);
    assert.ok(!f.calls.some(([name, id]) => name === 'delete' && id === '502'));
});

test('one slow account attempt yields to payouts without starting the rest of the signup queue', async t => {
    const f = deliveryFixture();
    const get = f.worker.store.accountAdmin.get;
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    f.worker.store.accountAdmin.get = async id => { now += 20000; return get(id); };
    await f.worker.cycle();
    assert.equal(f.calls.filter(([name]) => name === 'bot_prepare_account_mail').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'send').length, 1);
    assert.ok(!f.calls.some(([name, id]) => name === 'delete' && id === '501'));
});
