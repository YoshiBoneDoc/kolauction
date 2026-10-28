import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/catalog.mjs';
import { createCatalogRefresher } from '../src/catalog-refresh.mjs';
import { CATALOG_WEEK } from '../src/item-catalog-source.mjs';

const items = await readCatalog();
function fixture({ state = null, fetchSnapshot, readBundled } = {}) {
    let clock = Date.parse('2026-10-21T12:00:00Z');
    const calls = [], logs = [];
    const snapshot = () => ({ items, sha256: 'a'.repeat(64), fetched_at: new Date(clock).toISOString() });
    const store = { async rpc(name, params) {
        calls.push({ name, params });
        if (name === 'bot_item_catalog_state') return state;
        if (name === 'bot_replace_item_catalog') { state = { fetched_at: params.p_fetched_at }; return {}; }
        throw new Error('Unexpected mutation');
    } };
    let downloads = 0;
    const refresher = createCatalogRefresher({ store, now: () => clock, log: text => logs.push(text),
        fetchSnapshot: fetchSnapshot || (async () => { downloads++; return snapshot(); }), readBundled: readBundled || (async () => snapshot()) });
    return { refresher, calls, logs, advance(ms) { clock += ms; }, get downloads() { return downloads; } };
}

test('first startup bootstraps bundled eligibility, then refreshes weekly without a redeploy', async () => {
    const f = fixture();
    assert.equal(await f.refresher.refresh(), true);
    assert.equal(f.calls.filter(c => c.name === 'bot_replace_item_catalog').length, 1);
    assert.equal(f.downloads, 0);
    f.advance(CATALOG_WEEK - 1); await f.refresher.refresh(); assert.equal(f.downloads, 0);
    f.advance(1); await Promise.all([f.refresher.refresh(), f.refresher.refresh()]);
    assert.equal(f.downloads, 1);
    assert.equal(f.calls.filter(c => c.name === 'bot_replace_item_catalog').length, 2);
    assert.equal(f.calls.at(-1).params.p_items.find(item => item.id === 43).tradeable, false);
    f.refresher.stop();
});

test('restart honors persisted freshness; force refresh is available without waiting a week', async () => {
    const f = fixture({ state: { fetched_at: '2026-10-21T12:00:00Z' } });
    await f.refresher.refresh(); assert.equal(f.downloads, 0);
    await f.refresher.refresh({ force: true }); assert.equal(f.downloads, 1);
    f.refresher.stop();
});

test('download failures retain the catalog, never touch financial RPCs and retry after one hour', async () => {
    let downloads = 0;
    const f = fixture({ state: { fetched_at: '2026-10-01T12:00:00Z' }, fetchSnapshot: async () => { downloads++; throw new Error('Unavailable'); } });
    assert.equal(await f.refresher.refresh(), false);
    f.advance(3599999); await f.refresher.refresh(); assert.equal(downloads, 1);
    f.advance(1); await f.refresher.refresh(); assert.equal(downloads, 2);
    assert.ok(f.calls.every(call => call.name === 'bot_item_catalog_state'));
    assert.match(f.logs[0], /keeping the previous catalog/);
    f.refresher.stop();
});

test('stopping aborts a pending refresh and prevents snapshot writes', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const f = fixture({ state: { fetched_at: '2026-10-01T12:00:00Z' }, fetchSnapshot: () => pending });
    const running = f.refresher.refresh();
    await Promise.resolve();
    f.refresher.stop();
    resolve({ items, sha256: 'b'.repeat(64), fetched_at: '2026-10-21T12:00:00Z' });
    assert.equal(await running, false);
    assert.equal(f.calls.length, 1);
});

test('failed first database import identifies safe-update repair without logging raw errors or pretending a catalog exists', async () => {
    const logs = [], calls = [];
    const refresher = createCatalogRefresher({
        log: value => logs.push(value),
        readBundled: async () => ({ items, sha256: 'a'.repeat(64), fetched_at: new Date().toISOString() }),
        store: { async rpc(name) {
            calls.push(name);
            if (name === 'bot_item_catalog_state') return null;
            throw Object.assign(new Error('UPDATE requires a WHERE clause; private request content'), { code: '21000' });
        } },
    });
    assert.equal(await refresher.refresh(), false);
    assert.deepEqual(calls, ['bot_item_catalog_state', 'bot_replace_item_catalog']);
    assert.match(logs[0], /database import \(code 21000\)/);
    assert.match(logs[0], /catalog not initialized; new listings are unavailable/);
    assert.match(logs[0], /migration 054/);
    assert.doesNotMatch(logs[0], /private request|keeping the previous/);
    await refresher.refresh();
    assert.equal(calls.length, 2);
    refresher.stop();
});
