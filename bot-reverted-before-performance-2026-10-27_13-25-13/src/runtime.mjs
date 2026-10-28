import { createServer } from 'node:net';
import { EscrowWorker } from './worker.mjs';
import { createMarketPriceRefresher } from './market-prices.mjs';
import { createCatalogRefresher } from './catalog-refresh.mjs';
import { createChatAnnouncer } from './chat-announcements.mjs';

// Host-local guard. The remote Oracle copy must still be stopped manually.
export async function acquireWorkerLock(port = 38887) {
    const server = createServer(socket => socket.end());
    await new Promise((resolve, reject) => {
        server.once('error', () => {
            const error = new Error('Another local kHub worker is running, or its lock port is unavailable. Stop the existing worker before starting another.');
            error.exitCode = 78;
            reject(error);
        });
        server.listen(port, '127.0.0.1', resolve);
    });
    return server;
}

export function observeRequests(client, report) {
    if (typeof client.session !== 'function') return;
    const original = client.session;
    async function observe(fn, args) {
        report({ type: 'progress', state: client.isRollover?.() ? 'maintenance' : 'working' });
        try {
            // Bounds individual reads/login requests. Transfer requests keep their
            // explicit no-retry options; no request body/URL enters health reports.
            return await fn(args[0], { timeout: 20000, ...args[1] });
        } finally {
            report({ type: 'progress', state: client.isRollover?.() ? 'maintenance' : 'working' });
        }
    }
    const session = Object.assign((...args) => observe(original, args), original);
    if (original.raw) session.raw = (...args) => observe(original.raw, args);
    client.session = session;
}

export function observeStore(store, report) {
    const wrap = fn => async (...args) => {
        report({ type: 'progress', state: 'working' });
        try { return await fn(...args); }
        finally { report({ type: 'progress', state: 'working' }); }
    };
    return { ...store, rpc: wrap(store.rpc.bind(store)), accountAdmin: store.accountAdmin && Object.fromEntries(
        Object.entries(store.accountAdmin).map(([key, fn]) => [key, wrap(fn.bind(store.accountAdmin))])) };
}

export async function runWorker({ store, transport, live, poll, reserve, report, signal, log = console.log, chatEnabled = process.env.BOT_CHAT_ANNOUNCEMENTS !== 'false', chatChannel = process.env.BOT_CHAT_CHANNEL || 'trade', createAnnouncer = createChatAnnouncer, createMarketRefresher = createMarketPriceRefresher }) {
    if (signal.aborted) return;
    const worker = new EscrowWorker({ store: observeStore(store, report), transport, live, reserve, log,
        shouldStop: () => signal.aborted,
        pause: async () => { if (!signal.aborted) await wait(1000, signal); } });
    const chat = live && typeof transport.postChatAnnouncement === 'function' ? createAnnouncer({ transport, enabled: chatEnabled, channel: chatChannel, signal, log }) : null;
    const market = live ? createMarketRefresher({ store, transport, log, signal }) : null;
    const catalog = live ? createCatalogRefresher({ store, log, signal }) : null;
    try {
        // Run independently of mail/financial processing. One refresh is attempted
        // on startup when due, then weekly; failure retains the last good snapshot.
        catalog?.refresh();
        await transport.connect();
        if (signal.aborted) return;
        log(`kHub (#3888760): ${live ? 'LIVE escrow processing' : 'read-only; no mail deletion, payouts, or escrow mutations'}.`);
        while (!signal.aborted) {
            catalog?.refresh();
            const result = await worker.cycle();
            if (result?.state === 'healthy' && !signal.aborted) {
                // Read-only raw request on the same session; no login/recovery or
                // financial locks. Background work never delays the next cycle.
                market?.refresh();
                try { await chat?.tick(); }
                catch { log('Chat announcement deferred; auction processing continues.'); }
            }
            report({ type: 'cycle', state: result?.state || 'healthy', rollover_at: transport.nextRollover,
                maintenance: Boolean(transport.client?.isRollover?.()) });
            if (!signal.aborted) await wait(poll * 1000, signal);
        }
    } finally { market?.stop(); catalog?.stop(); }
}

export function wait(ms, signal) {
    return new Promise(resolve => {
        if (signal?.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}
