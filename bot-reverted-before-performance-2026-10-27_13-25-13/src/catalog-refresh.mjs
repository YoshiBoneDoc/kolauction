import { readFile } from 'node:fs/promises';
import { CATALOG_WEEK, fetchItemCatalog, validateCatalog } from './item-catalog-source.mjs';

async function bundledSnapshot() {
    const [items, meta] = await Promise.all(['items.json', 'items.meta.json'].map(name => readFile(new URL(`../catalog/${name}`, import.meta.url), 'utf8').then(JSON.parse)));
    return { ...meta, items: validateCatalog(items) };
}

export function createCatalogRefresher({ store, log = console.log, signal, now = Date.now, fetchSnapshot = fetchItemCatalog, readBundled = bundledSnapshot }) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    let nextCheck = 0;
    let running;
    let stage;
    async function apply(snapshot) {
        if (controller.signal.aborted) return false;
        stage = 'snapshot validation';
        validateCatalog(snapshot.items);
        stage = 'database import';
        await store.rpc('bot_replace_item_catalog', { p_items: snapshot.items, p_fetched_at: snapshot.fetched_at, p_source_sha256: snapshot.sha256 });
        return true;
    }
    async function check(force) {
        let initialized = false;
        try {
            stage = 'database status check';
            let state = await store.rpc('bot_item_catalog_state');
            initialized = Boolean(state?.fetched_at);
            if (controller.signal.aborted) return false;
            if (!state?.fetched_at) {
                stage = 'bundled catalog read';
                const bundled = await readBundled();
                if (!await apply(bundled)) return false;
                initialized = true;
                state = bundled;
                log(`Item catalog initialized: ${bundled.items.length} known items; only tradeable items may be listed.`);
            }
            const due = Date.parse(state.fetched_at) + CATALOG_WEEK;
            if (!force && Number.isFinite(due) && due > now()) {
                nextCheck = due;
                return true;
            }
            stage = 'upstream download';
            const snapshot = await fetchSnapshot({ signal: controller.signal });
            if (!await apply(snapshot)) return false;
            nextCheck = Date.parse(snapshot.fetched_at) + CATALOG_WEEK;
            log(`Item catalog refreshed: ${snapshot.items.length} known items; next automatic refresh in one week.`);
            return true;
        } catch (error) {
            // Reference-data outages must never stop refunds, settlement or mail.
            nextCheck = now() + 60 * 60 * 1000;
            const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(error.code) ? error.code : null;
            const retained = initialized ? 'keeping the previous catalog' : 'catalog not initialized; new listings are unavailable';
            const help = code === '21000' && stage === 'database import'
                ? ' Apply migration 054 to fix the safe-update import restriction.' : '';
            if (!controller.signal.aborted) log(`Item catalog refresh unavailable during ${stage}${code ? ` (code ${code})` : ''}; ${retained}; retrying in one hour.${help}`);
            return false;
        }
    }
    return {
        refresh({ force = false } = {}) {
            if (controller.signal.aborted || (!force && now() < nextCheck)) return Promise.resolve(false);
            if (!running) running = check(force).finally(() => { running = null; });
            return running;
        },
        stop() { signal?.removeEventListener('abort', stop); stop(); },
    };
}
