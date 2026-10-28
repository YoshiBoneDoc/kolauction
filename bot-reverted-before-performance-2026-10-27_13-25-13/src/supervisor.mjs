import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { saveHealth, states } from './health.mjs';

export const policy = {
    checkMs: 5000, heartbeatMs: 90000, progressMs: 300000,
    rolloverMs: 600000, graceMs: 60000, retryMs: 5000, maxRetryMs: 60000,
};

export class Supervisor {
    constructor({ spawnWorker, writeHealth = saveHealth, log = console.log, limits = {}, clock = () => performance.now(), wallClock = Date.now } = {}) {
        Object.assign(this, { spawnWorker, writeHealth, log, clock, wallClock });
        this.limits = { ...policy, ...limits };
        this.controller = new AbortController();
        this.restartCount = 0;
        this.failures = 0;
        this.lastRolloverRestart = -Infinity;
        this.state = 'starting';
    }
    publish() {
        if (!this.owned) return;
        const value = { version: 1, supervisor_pid: process.pid, worker_pid: this.child?.pid ?? null,
            state: this.state, reason: this.reason ?? null, updated_at: new Date(this.wallClock()).toISOString(),
            last_successful_cycle_at: this.lastSuccess ?? null, last_cycle_at: this.lastCycle ?? null,
            last_progress_at: this.lastProgressAt ?? null, restart_count: this.restartCount };
        try { this.writeHealth(value); this.healthWriteFailed = false; }
        catch {
            if (!this.healthWriteFailed) this.log('Could not write bot health status; the health monitor remains active. Check local storage.');
            this.healthWriteFailed = true;
        }
    }
    stop() {
        if (this.stopping) return;
        this.stopping = true;
        this.controller.abort();
        this.state = 'stopping';
        this.publish();
        this.requestExit();
    }
    requestExit() {
        if (!this.child || this.exitRequested) return;
        this.exitRequested = true;
        // A signal requests a stop at an operation boundary; never spawn the
        // replacement until the old process has actually exited.
        this.child.kill('SIGTERM');
        this.killTimer = setTimeout(() => {
            this.log('Worker did not stop within the grace period; terminating it. Any unacknowledged transfers remain blocked in Supabase.');
            this.child?.kill('SIGKILL');
        }, this.limits.graceMs);
    }
    restart(reason) {
        if (this.exitRequested || this.stopping) return;
        this.reason = reason;
        this.state = 'restarting';
        this.log(`kHub health monitor: ${reason}; requesting a worker restart.`);
        this.publish();
        this.requestExit();
    }
    check() {
        const now = this.clock();
        if (now - this.lastHeartbeat > this.limits.heartbeatMs) this.restart('worker heartbeat stopped');
        else if (now - this.lastProgress > this.limits.progressMs) this.restart('worker made no progress');
        this.publish();
    }
    message(message) {
        if (!message || !['ready', 'heartbeat', 'progress', 'cycle'].includes(message.type)) return;
        this.lastHeartbeat = this.clock();
        if (message.type === 'ready') this.owned = true;
        if (message.type === 'heartbeat') return;
        this.lastProgress = this.clock();
        this.lastProgressAt = new Date(this.wallClock()).toISOString();
        if (!this.exitRequested && !this.stopping && states.has(message.state)) this.state = message.state;
        if (message.type === 'cycle') {
            this.lastCycle = new Date(this.wallClock()).toISOString();
            if (message.state === 'blocked') this.reason = 'ledger reconciliation required';
            if (['healthy', 'read-only'].includes(message.state)) {
                this.lastSuccess = this.lastCycle;
                this.failures = 0;
                this.reason = null;
            }
            // A blocked ledger needs evidence, not repeated logins. Maintenance
            // can last arbitrarily long while read probes keep making progress.
            if (message.state === 'rollover' && !message.maintenance && Number.isFinite(message.rollover_at)
                && this.wallClock() - message.rollover_at > this.limits.rolloverMs
                && this.clock() - this.lastRolloverRestart > this.limits.rolloverMs) {
                this.lastRolloverRestart = this.clock();
                this.restart('rollover time stayed stale after maintenance');
            }
        }
        if (message.type !== 'progress') this.publish();
    }
    async runChild() {
        this.exitRequested = false;
        this.lastHeartbeat = this.lastProgress = this.clock();
        this.state = 'starting';
        const child = this.child = this.spawnWorker();
        return await new Promise(resolve => {
            let done = false;
            const finish = code => {
                if (done) return;
                done = true;
                clearInterval(interval);
                clearTimeout(this.killTimer);
                child.removeListener('message', onMessage);
                this.child = null;
                resolve(code);
            };
            const onMessage = message => this.message(message);
            child.on('message', onMessage);
            child.once('exit', code => finish(code));
            child.once('error', () => { if (!child.pid) finish(1); });
            const interval = setInterval(() => this.check(), this.limits.checkMs);
            if (this.stopping) this.requestExit();
        });
    }
    async run() {
        while (!this.stopping) {
            let code;
            try { code = await this.runChild(); }
            catch { code = 1; }
            if (this.stopping) break;
            if (code === 78) {
                // The rejected duplicate must not overwrite the active bot's file.
                this.log('Worker refused to start: check configuration and existing local workers. Automatic retry is disabled.');
                return 78;
            }
            this.state = 'error';
            this.reason = this.reason || 'worker exited';
            this.publish();
            const delay = Math.min(this.limits.maxRetryMs, this.limits.retryMs * 2 ** Math.min(this.failures++, 10));
            this.log(`kHub worker exited; retrying in ${Math.ceil(delay / 1000)} seconds. Ledger review blocks remain in force.`);
            await new Promise(resolve => {
                const finish = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', finish); resolve(); };
                const timer = setTimeout(finish, delay);
                if (this.stopping) finish();
                else this.controller.signal.addEventListener('abort', finish, { once: true });
            });
            if (!this.stopping) this.restartCount++;
        }
        this.state = 'stopped';
        this.publish();
        return 0;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (Number(process.versions.node.split('.')[0]) < 24) {
        console.error('kHub requires Node 24 or later. Switch Node versions before running npm start.');
        process.exit(78);
    }
    const supervisor = new Supervisor({ spawnWorker: () => fork(fileURLToPath(new URL('./cli.mjs', import.meta.url)), ['run'],
        { execArgv: [], stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => supervisor.stop());
    console.log('kHub health monitor enabled. Ctrl+C stops the monitor and its worker.');
    process.exitCode = await supervisor.run();
}
