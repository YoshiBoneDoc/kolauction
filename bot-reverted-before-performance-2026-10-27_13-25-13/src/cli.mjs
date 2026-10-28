import { createCatalogRefresher } from './catalog-refresh.mjs';
import { createStore } from './store.mjs';
import { acquireWorkerLock, observeRequests, runWorker } from './runtime.mjs';
import { financialSummary, financialHistory } from './financial.mjs';

const [command = 'inspect', id, resolution, ...evidence] = process.argv.slice(2);
try {
    if (command === 'run' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
        const error = new Error('Set server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in bot/.env.');
        error.exitCode = 78;
        throw error;
    }
    let store;
    try { store = createStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); }
    catch (error) { if (command === 'run') error.exitCode = 78; throw error; }
    if (command === 'inspect') console.log(JSON.stringify(await store.rpc('bot_inspect'), null, 2));
    else if (command === 'stats') {
        if (!id || id === 'summary') console.log(financialSummary(await store.rpc('bot_financial_stats')));
        else {
            const page = Number(resolution || 1);
            if (!['donations','sales','buy-orders'].includes(id) || !/^[1-9][0-9]*$/.test(String(resolution || 1))
                || !Number.isSafeInteger(page) || !Number.isSafeInteger((page - 1) * 20)) {
                throw new Error('Usage: stats [summary|donations|sales|buy-orders] [page number starting at 1]');
            }
            console.log(financialHistory(await store.rpc('bot_financial_history', { p_kind: id, p_offset: (page - 1) * 20, p_limit: 20 }), page));
        }
    } else if (command === 'sync-catalog') {
        const catalog = createCatalogRefresher({ store });
        try {
            if (!await catalog.refresh({ force: true })) throw new Error('Catalog refresh was not confirmed. The previous catalog remains available.');
        } finally { catalog.stop(); }
    } else if (command === 'lookup') {
        console.log(JSON.stringify(await store.rpc('bot_lookup_delivery', { p_reference: id }), null, 2));
    } else if (command === 'retry-delivery') {
        const reason = [resolution, ...evidence].filter(Boolean).join(' ');
        if (reason.trim().length < 12) throw new Error('Usage: retry-delivery <D-reference or UUID> <correction, at least 12 characters>. This releases only a fixed, unsent preparation hold.');
        const delivery = await store.rpc('bot_lookup_delivery', { p_reference: id });
        await store.rpc('bot_retry_held_delivery', { p_id: delivery.id, p_evidence: reason });
        console.log('Preparation hold released. The delivery will be attempted by the worker; nothing was sent by this command.');
    } else if (command === 'resolve') {
        if (!['sent', 'not-sent'].includes(resolution) || evidence.join(' ').length < 12) throw new Error('Usage: resolve <delivery-id> sent|not-sent <KoL evidence, at least 12 characters>. Stop every bot instance before resolving.');
        const delivery = await store.rpc('bot_lookup_delivery', { p_reference: id });
        await store.rpc('bot_reconcile_delivery', { p_id: delivery.id, p_sent: resolution === 'sent', p_evidence: evidence.join(' ') });
        console.log('Reconciliation recorded.');
    } else if (command === 'inspect-gifts') {
        console.log(JSON.stringify(await store.rpc('bot_gift_intake_state'), null, 2));
    } else if (['resolve-gift-review', 'resolve-gift-isolation'].includes(command)) {
        const reason = [resolution, ...evidence].filter(Boolean).join(' ');
        if (reason.trim().length < 20) throw new Error('Record original KMail and reconciled asset evidence. Stop workers before resolving.');
        await store.rpc(command === 'resolve-gift-review' ? 'bot_resolve_gift_review' : 'bot_resolve_gift_isolation',
            { [command === 'resolve-gift-review' ? 'p_mail_id' : 'p_attempt']: id, p_evidence: reason });
        console.log('Gift review resolution recorded. No mail, items or Meat were sent by this command.');
    } else if (command === 'resolve-gift-not-opened') {
        const reason = [resolution, ...evidence].filter(Boolean).join(' ');
        if (reason.trim().length < 20) throw new Error('Usage: resolve-gift-not-opened <attempt UUID> <verified unchanged inventory AND unopened original KMail evidence>. Stop all workers first.');
        await store.rpc('bot_resolve_gift_not_opened', { p_attempt: id, p_evidence: reason });
        console.log('Confirmed no-open attempt released; no package was opened by this command.');
    } else if (command === 'lookup-closet') {
        console.log(JSON.stringify(await store.rpc('bot_lookup_closet_transfer', { p_reference: id }), null, 2));
    } else if (command === 'resolve-closet') {
        if (!['moved','not-moved'].includes(resolution) || evidence.join(' ').length < 12) throw new Error('Usage: resolve-closet <C-reference or UUID> moved|not-moved <inventory/closet evidence>. Stop all workers first.');
        const transfer = await store.rpc('bot_lookup_closet_transfer', { p_reference: id });
        await store.rpc('bot_reconcile_closet_transfer', { p_id: transfer.id, p_moved: resolution === 'moved', p_evidence: evidence.join(' ') });
        console.log('Closet reconciliation recorded.');
    } else if (command === 'cancel-opened-package') {
        const reason = [resolution, ...evidence].filter(Boolean).join(' ');
        if (reason.trim().length < 12) throw new Error('Usage: cancel-opened-package <C-reference or UUID> <reason>. Stop every bot first. Only never-attempted pending gift-package wrapper plans are eligible.');
        const transfer = await store.rpc('bot_lookup_closet_transfer', { p_reference: id });
        await store.rpc('bot_cancel_opened_package', { p_id: transfer.id, p_evidence: reason });
        console.log('Obsolete wrapper plan cancelled and audit recorded. No assets moved.');
    } else if (command === 'diagnose-closet') {
        try {
            const { KolTransport } = await import('./transport.mjs');
            const transport = new KolTransport(process.env.KOL_USERNAME, process.env.KOL_PASSWORD);
            await transport.connect();
            console.log(JSON.stringify(await transport.diagnoseCloset(), null, 2));
        } catch {
            throw new Error('KoL closet diagnostic failed; no transfers were attempted. Keep other bot instances stopped while diagnosing.');
        }
    } else if (command === 'run') {
        const live = process.env.BOT_LIVE === 'true';
        const poll = Number(process.env.BOT_POLL_SECONDS || 15);
        const reserve = Number(process.env.BOT_MEAT_RESERVE || 0);
        if (!Number.isSafeInteger(poll) || poll < 10 || !Number.isSafeInteger(reserve) || reserve < 0
            || !process.env.KOL_PASSWORD || process.env.KOL_USERNAME?.toLowerCase() !== 'khub') {
            const error = new Error('Check kHub credentials, poll interval (at least 10 seconds), and nonnegative whole-number reserve.');
            error.exitCode = 78;
            throw error;
        }
        const lock = await acquireWorkerLock();
        const controller = new AbortController();
        const report = message => { if (process.connected) process.send(message, () => {}); };
        let stopTimer;
        const stop = () => {
            if (controller.signal.aborted) return;
            controller.abort();
            // Also prevents an orphan worker surviving a dead supervisor forever.
            stopTimer = setTimeout(() => process.exit(1), 60000);
            stopTimer.unref();
        };
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
        if (process.send) process.on('disconnect', stop);
        const heartbeat = setInterval(() => report({ type: 'heartbeat' }), 15000);
        let transport;
        try {
            report({ type: 'ready', state: 'starting' });
            const { KolTransport } = await import('./transport.mjs');
            transport = new KolTransport(process.env.KOL_USERNAME, process.env.KOL_PASSWORD);
            observeRequests(transport.client, report);
            await runWorker({ store, transport, live, poll, reserve, report, signal: controller.signal });
        } finally {
            clearInterval(heartbeat);
            clearTimeout(stopTimer);
            for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
            if (process.send) process.removeListener('disconnect', stop);
            transport?.client.dispose?.();
            lock.close();
            if (process.connected) process.disconnect();
        }
    } else throw new Error('Commands: inspect, stats [summary|donations|sales|buy-orders] [page], lookup <D-reference or UUID>, sync-catalog, run, retry-delivery, resolve, lookup-closet, resolve-closet, diagnose-closet, cancel-opened-package, inspect-gifts, resolve-gift-not-opened, resolve-gift-review, resolve-gift-isolation.');
} catch (error) {
    // Deliberately stop on uncertainty. A supervisor may restart, but persistent
    // sending/unknown rows still block every new payout until reconciled.
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
}
