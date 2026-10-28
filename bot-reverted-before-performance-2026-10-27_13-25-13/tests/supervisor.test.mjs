import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.mjs';
import { readHealth, saveHealth } from '../src/health.mjs';
import { acquireWorkerLock, observeRequests, runWorker } from '../src/runtime.mjs';
import { EscrowWorker } from '../src/worker.mjs';

const fixture = fileURLToPath(new URL('./fixtures/health-worker.mjs', import.meta.url));
async function until(check) {
    const deadline = Date.now() + 6000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for fake worker');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
function setup(t, modes, path) {
    let starts = 0;
    const children = [], snapshots = [], logs = [], overlaps = [];
    const supervisor = new Supervisor({
        limits: { checkMs: 20, heartbeatMs: 1500, progressMs: 600, graceMs: 150, retryMs: 10, maxRetryMs: 20 },
        spawnWorker() {
            overlaps.push(children.some(child => child.exitCode === null && child.signalCode === null));
            const child = fork(fixture, [modes[Math.min(starts++, modes.length - 1)], ...(path ? [path] : [])],
                { execArgv: [], env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            children.push(child);
            return child;
        }, writeHealth: value => snapshots.push(value), log: value => logs.push(value),
    });
    const running = supervisor.run();
    t.after(async () => { supervisor.stop(); await running; });
    return { supervisor, running, children, snapshots, logs, overlaps, starts: () => starts };
}

test('a crashed worker restarts and Ctrl+C-style stop leaves no replacement', async t => {
    const f = setup(t, ['crash', 'healthy']);
    await until(() => f.snapshots.some(value => value.state === 'healthy'));
    assert.equal(f.starts(), 2);
    assert.equal(f.supervisor.restartCount, 1);
    f.supervisor.stop();
    await f.running;
    assert.equal(f.starts(), 2);
    assert.equal(f.snapshots.at(-1).state, 'stopped');
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('watchdog recovers a frozen event loop and waits for actual process exit', async t => {
    const f = setup(t, ['hang', 'healthy']);
    await until(() => f.snapshots.some(value => value.state === 'healthy'));
    assert.equal(f.starts(), 2);
    assert.equal(f.children[0].signalCode, 'SIGKILL');
    assert.ok(f.logs.some(value => value.includes('no progress')));
    assert.ok(f.overlaps.every(value => !value));
});

test('a cooperative restart waits for graceful shutdown rather than killing the worker', async t => {
    const f = setup(t, ['delayed-stop', 'healthy']);
    await until(() => f.snapshots.some(value => value.state === 'healthy'));
    f.supervisor.restart('test restart');
    await until(() => f.starts() === 2 && f.snapshots.at(-1)?.state === 'healthy');
    assert.equal(f.children[0].exitCode, 0);
    assert.equal(f.children[0].signalCode, null);
    assert.ok(f.overlaps.every(value => !value));
});

test('a worker stuck on a stale rollover is replaced at a cycle boundary', async t => {
    const f = setup(t, ['rollover', 'healthy']);
    await until(() => f.snapshots.some(value => value.state === 'healthy'));
    assert.equal(f.starts(), 2);
    assert.equal(f.children[0].exitCode, 0);
    assert.ok(f.overlaps.every(value => !value));
    assert.ok(f.logs.some(value => value.includes('rollover time stayed stale')));
});

test('an interrupted transfer stays blocked after a real child-process restart', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'khub-supervisor-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'fake-ledger.json');
    writeFileSync(path, '{}');
    const f = setup(t, ['uncertain'], path);
    await until(() => f.snapshots.some(value => value.state === 'blocked'));
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(ledger.sends, 1);
    assert.equal(ledger.state, 'sending');
    assert.equal(f.starts(), 2);
    assert.equal(f.children[0].signalCode, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.starts(), 2, 'blocked worker is not restarted repeatedly');
});

test('duplicate/configuration rejection disables retries and preserves existing health', async t => {
    const f = setup(t, ['duplicate']);
    assert.equal(await f.running, 78);
    assert.equal(f.starts(), 1);
    assert.equal(f.snapshots.length, 0);
});

test('maintenance probes and blocked ledger cycles are progress, even during a long rollover', () => {
    let clock = 0;
    const supervisor = new Supervisor({ clock: () => clock, wallClock: () => 2000000,
        writeHealth: () => {}, log: () => {} });
    const reasons = [];
    supervisor.restart = reason => reasons.push(reason);
    supervisor.message({ type: 'ready', state: 'starting' });
    for (let n = 0; n < 40; n++) {
        clock += 60000;
        supervisor.message({ type: 'progress', state: 'maintenance' });
        supervisor.check();
    }
    supervisor.message({ type: 'cycle', state: 'rollover', rollover_at: 1, maintenance: true });
    supervisor.message({ type: 'cycle', state: 'blocked', rollover_at: 1, maintenance: false });
    supervisor.check();
    assert.deepEqual(reasons, []);
    assert.equal(supervisor.state, 'blocked');
});

test('heartbeats alone cannot hide stalled work, and stale rollover recovery is rate limited', () => {
    let clock = 0;
    const supervisor = new Supervisor({ clock: () => clock, wallClock: () => 2000000, writeHealth: () => {}, log: () => {} });
    const reasons = [];
    supervisor.restart = reason => reasons.push(reason);
    supervisor.message({ type: 'ready', state: 'starting' });
    clock = 310000;
    supervisor.message({ type: 'heartbeat' });
    supervisor.check();
    assert.deepEqual(reasons, ['worker made no progress']);
    reasons.length = 0;
    for (let n = 0; n < 2; n++) supervisor.message({ type: 'cycle', state: 'rollover', rollover_at: 1, maintenance: false });
    assert.deepEqual(reasons, ['rollover time stayed stale after maintenance']);
});

test('missing heartbeats trigger recovery even before the operation progress deadline', () => {
    let clock = 0;
    const supervisor = new Supervisor({ clock: () => clock, writeHealth: () => {} });
    const reasons = [];
    supervisor.restart = reason => reasons.push(reason);
    supervisor.message({ type: 'ready', state: 'starting' });
    clock = 91000;
    supervisor.check();
    assert.deepEqual(reasons, ['worker heartbeat stopped']);
});

test('health status is atomic, private, and detects a stopped heartbeat', t => {
    const dir = mkdtempSync(join(tmpdir(), 'khub-health-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'health.json');
    const now = Date.now();
    saveHealth({ supervisor_pid: process.pid, state: 'blocked', updated_at: new Date(now).toISOString() }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readHealth(path, now).state, 'blocked');
    assert.equal(readHealth(path, now + 91000).state, 'stale');
    saveHealth({ supervisor_pid: process.pid, state: 'stopped', updated_at: new Date(now).toISOString() }, path);
    assert.equal(readHealth(path, now + 86400000).state, 'stopped');
    assert.equal(readHealth(join(dir, 'absent')).state, 'unavailable');
});

test('health storage failure does not kill the supervisor or expose error details', () => {
    const logs = [];
    const supervisor = new Supervisor({ writeHealth() { throw new Error('private secret'); }, log: value => logs.push(value) });
    supervisor.message({ type: 'ready', state: 'starting' });
    supervisor.message({ type: 'cycle', state: 'healthy', password: 'private secret' });
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes('private secret'));
});

test('observed KoL requests preserve one-shot transfer options and never report secrets', async () => {
    const calls = [], reports = [];
    const original = async (path, options) => { calls.push({ path, options }); return 'sent'; };
    original.raw = original;
    const client = { session: original, isRollover: () => false };
    observeRequests(client, value => reports.push(value));
    const body = new URLSearchParams({ pwd: 'private secret' });
    await client.session.raw('sendmessage.php', { method: 'POST', body, retry: 0, redirect: 'manual' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body, body);
    assert.equal(calls[0].options.retry, 0);
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.timeout, 20000);
    assert.ok(!JSON.stringify(reports).includes('private secret'));
});

test('stopping an idle worker interrupts the polling sleep', async () => {
    const controller = new AbortController();
    const reports = [];
    await runWorker({ live: false, poll: 3600, reserve: 0, signal: controller.signal, log: () => {},
        report(value) { reports.push(value); if (value.type === 'cycle') controller.abort(); },
        store: { async rpc() { return { attention: [], closetAttention: [] }; } },
        transport: { async connect() {}, async inbox() { return []; } },
    });
    assert.equal(reports.at(-1).state, 'read-only');
});

test('shutdown finishes the current delivery acknowledgment before claiming anything else', async () => {
    let stopping = false;
    const calls = [];
    const worker = new EscrowWorker({ live: true, shouldStop: () => stopping, log: () => {},
        store: { async rpc(name) {
            calls.push(name);
            if (name === 'bot_inspect') return { attention: [], closetAttention: [] };
            if (name === 'bot_liabilities') return { meat: '0', items: {} };
            if (name === 'bot_claim_delivery') return { id: 'delivery', meat: '0' };
        } },
        transport: { async inbox() { return []; }, async snapshot() { return { meat: '0', items: {} }; },
            async send() { stopping = true; return 'acknowledged'; } },
    });
    assert.deepEqual(await worker.cycle(), { state: 'stopping' });
    assert.equal(calls.filter(name => name === 'bot_claim_delivery').length, 1);
    assert.equal(calls.at(-1), 'bot_ack_delivery');
});

test('host-local worker guard rejects a second process and releases cleanly', async t => {
    const first = await acquireWorkerLock(0);
    t.after(() => first.close());
    const port = first.address().port;
    await assert.rejects(acquireWorkerLock(port), error => error.exitCode === 78);
    await new Promise(resolve => first.close(resolve));
    const replacement = await acquireWorkerLock(port);
    await new Promise(resolve => replacement.close(resolve));
});
