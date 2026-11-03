import { overlayLive, unavailableRow } from './liveState.js';
import { CACHE_VERSION, publicRequest, publicProjection, originRequest } from './protocol.js';
import { readInvalidation, verifyInvalidation, validRevision } from './invalidation.js';
import { cacheFailure, cacheErrorBody, originFailureCode, safeCacheCode } from './errors.js';

const FRESH_MS = 30000;
const MAX_AGE_MS = 300000;
const MAX_ENTRIES = 48;
// SQLite-backed Durable Object KV values have a 2 MB key+value limit.
// Keep the full persisted cache below 1 MB, including non-ASCII item names.
const MAX_BYTES = 1024 * 1024;
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const MAX_PENDING = 4;
const STORE_KEY = `public-snapshots-v${CACHE_VERSION}`;
const unavailable = cacheFailure;
const changedDuringRead = () => unavailable('CACHE_CHANGED');

// One named object for the whole site: concurrent visitors share the same reads,
// including across Cloudflare regions. The public Worker URL exposes no API.
export class PublicAuctionCache {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.entries = new Map();
        this.inflight = new Map();
        this.queue = Promise.resolve();
        this.cooldownUntil = 0;
        this.lastFailureCode = 'CACHE_UNAVAILABLE';
        this.lastOriginAt = 0;
        this.revision = '0';
        this.legacyRevision = '0';
        this.auctionRevisions = new Map();
        this.failures = new Map();
        this.liveStates = new Map();
        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get(STORE_KEY);
            this.revision = validRevision(saved?.revision) ? saved.revision : '0';
            this.legacyRevision = validRevision(saved?.legacyRevision) ? saved.legacyRevision : this.revision;
            this.auctionRevisions = new Map(saved?.auctionRevisions || []);
            this.failures = new Map((saved?.failures || []).filter(([, failure]) => failure.until > Date.now()));
            const now = Date.now();
            for (const [key, entry] of saved?.entries || []) {
                if (now - entry.storedAt <= MAX_AGE_MS) this.entries.set(key, entry);
            }
            this.cooldownUntil = Math.min(saved?.cooldownUntil || 0, now + 30000);
            this.lastFailureCode = safeCacheCode(saved?.failureCode);
        });
    }

    async persist() {
        // Capture the latest map after asynchronous refreshes finish, with bounded storage.
        await this.ctx.storage.put(STORE_KEY, { entries: [...this.entries], cooldownUntil: this.cooldownUntil, revision: this.revision, failureCode: this.lastFailureCode, legacyRevision: this.legacyRevision, auctionRevisions: [...this.auctionRevisions], failures: [...this.failures] });
    }

    async invalidate(request) {
        let payload;
        try { payload = await readInvalidation(request); }
        catch { return Response.json({ error: 'Invalid notification.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
        if (!await verifyInvalidation(payload, this.env.PUBLIC_CACHE_INVALIDATION_SECRET)) {
            return Response.json({ error: 'Invalid signature.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
        }
        // Ignore retries and reordered deliveries. Only public freshness metadata
        // is persisted, never the signing key or the signed notification itself.
        if (payload.auction_id) {
            const previous = this.auctionRevisions.get(payload.auction_id) || '0';
            if (BigInt(payload.revision) > BigInt(previous)) this.auctionRevisions.set(payload.auction_id, payload.revision);
            // Bound persisted metadata. Eviction becomes a conservative legacy
            // invalidation, never silently forgets an auction's newer state.
            while (this.auctionRevisions.size > 512) {
                const [id, revision] = this.auctionRevisions.entries().next().value;
                if (BigInt(revision) > BigInt(this.legacyRevision)) this.legacyRevision = revision;
                this.auctionRevisions.delete(id);
            }
        } else if (BigInt(payload.revision) > BigInt(this.legacyRevision)) {
            this.legacyRevision = payload.revision;
        }
        if (BigInt(payload.revision) > BigInt(this.revision)) this.revision = payload.revision;
        await this.persist();
        return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }

    async readOrigin(request) {
        let base;
        try { base = new URL(this.env.SUPABASE_URL); }
        catch { throw unavailable('CACHE_CONFIG_URL'); }
        if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw unavailable('CACHE_CONFIG_URL');
        // Dashboard users may copy the website's public variable name. Both
        // names refer to the same publishable key; validate either identically.
        const key = this.env.SUPABASE_PUBLISHABLE_KEY || this.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
        // Reject privileged keys even if configured accidentally. No service role exists here.
        let anonymous = key.startsWith('sb_publishable_');
        if (!anonymous) {
            try { anonymous = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
            catch { /* Invalid or privileged keys fail closed. */ }
        }
        if (!anonymous) throw unavailable('CACHE_CONFIG_KEY');
        const { rpc, args } = originRequest(request);
        const headers = { apikey: key, 'Content-Type': 'application/json' };
        // Legacy anonymous JWT keys need Authorization; new publishable keys do not.
        if (!key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;
        const startedAt = Date.now();
        let response, text;
        try {
            response = await fetch(new URL(`/rest/v1/rpc/${rpc}`, base), {
                // Workers supports manual/follow, not redirect:error. Manual
                // keeps the public key from being forwarded to another host.
                method: 'POST', headers, body: JSON.stringify(args), redirect: 'manual',
                signal: AbortSignal.timeout(8000),
            });
            text = await response.text();
        } catch (error) {
            throw unavailable(['TimeoutError', 'AbortError'].includes(error?.name) ? 'CACHE_ORIGIN_TIMEOUT' : 'CACHE_ORIGIN_ERROR');
        }
        if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw unavailable('CACHE_RESPONSE_TOO_LARGE');
        if (!response.ok) {
            let databaseCode;
            try { databaseCode = JSON.parse(text)?.code; } catch { /* No raw body is exposed. */ }
            throw unavailable(originFailureCode(response.status, databaseCode));
        }
        // Supabase's Cloudflare gateway may set __cf_bm even for anonymous
        // public reads. Ignore origin cookies: only projected JSON is stored,
        // and no upstream headers or cookies are forwarded to visitors.
        let result;
        try { result = publicProjection(JSON.parse(text), request); }
        catch { throw unavailable('CACHE_INVALID_RESPONSE'); }
        result.server_time = new Date(Date.parse(result.server_time) + (Date.now() - startedAt) / 2).toISOString();
        return result;
    }

    family(request) {
        return request.view === 'batch-live' || request.view === 'detail-live' ? 'live'
            : request.view === 'seller' ? 'browse' : request.view;
    }

    failureScope(request) {
        // A malformed/expensive live batch must not pause every other auction.
        if (request.view === 'batch-live') return `live:${JSON.stringify(request.ids)}`;
        if (request.view === 'detail-live') return `live:${JSON.stringify([request.id])}`;
        return this.family(request);
    }

    changed(request, revision = '0') {
        if (BigInt(this.legacyRevision) > BigInt(revision)) return true;
        const ids = request.view === 'batch-live' ? request.ids
            : request.view.startsWith('detail-') ? [request.id] : null;
        // Membership/order can change even when the bidder's auction was not
        // on the old page. Only live state is safe to invalidate by page IDs.
        return ids ? ids.some(id => BigInt(this.auctionRevisions.get(id) || '0') > BigInt(revision))
            : BigInt(this.revision) > BigInt(revision);
    }

    blocked(request) {
        if (Date.now() < this.cooldownUntil) return this.lastFailureCode;
        const failure = this.failures.get(this.failureScope(request));
        return failure?.until > Date.now() ? failure.code : null;
    }

    refresh(key, request) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        const blocked = this.blocked(request);
        if (blocked) return Promise.reject(unavailable(blocked));
        if (this.inflight.size >= MAX_PENDING) return Promise.reject(unavailable('CACHE_QUEUE_FULL'));
        const task = this.queue.then(async () => {
            const blocked = this.blocked(request);
            if (blocked) throw unavailable(blocked);
            try {
                let entry;
                for (let attempt = 0; attempt < 2; attempt++) {
                    // Rate limit retries as well as distinct query keys.
                    const delay = Math.max(0, this.lastOriginAt + 1000 - Date.now());
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    this.lastOriginAt = Date.now();
                    const revision = this.revision;
                    const data = await this.readOrigin(this.env.LIVE_AUCTION_STATE === 'true' && request.view === 'detail-live'
                        ? { view: 'batch-live', ids: [request.id] } : request);
                    if (this.changed(request, revision)) continue;
                    entry = { data, storedAt: Date.now(), revision };
                    break;
                }
                if (!entry) throw changedDuringRead();
                this.entries.delete(key);
                this.entries.set(key, entry);
                while (this.entries.size > MAX_ENTRIES || jsonBytes([...this.entries]) > MAX_BYTES) {
                    this.entries.delete(this.entries.keys().next().value);
                }
                this.failures.delete(this.failureScope(request));
                if (Date.now() >= this.cooldownUntil) { this.cooldownUntil = 0; this.lastFailureCode = 'CACHE_UNAVAILABLE'; }
                await this.persist();
                return entry;
            } catch (error) {
                // A failing database gets breathing room, not a retry from every visitor.
                if (error.code !== 'CACHE_CHANGED') {
                    const code = safeCacheCode(error.code);
                    const now = Date.now();
                    for (const [family, failure] of this.failures) if (failure.until <= now) this.failures.delete(family);
                    this.failures.set(this.failureScope(request), { until: now + 30000, code, family: this.family(request) });
                    while (this.failures.size > 48) this.failures.delete(this.failures.keys().next().value);
                    const transient = [...this.failures.values()].filter(f => !['CACHE_RPC_MISSING', 'CACHE_ORIGIN_PERMISSION', 'CACHE_INVALID_RESPONSE'].includes(f.code));
                    // One expensive query is not proof of a database outage.
                    // Shared config/auth failures, or failures in two independent
                    // RPC families, retain a database-wide circuit breaker.
                    if (['CACHE_CONFIG_URL', 'CACHE_CONFIG_KEY', 'CACHE_ORIGIN_AUTH'].includes(code)
                        || new Set(transient.map(f => f.family || 'legacy')).size >= 2 || transient.length >= 3) {
                        this.cooldownUntil = now + 30000;
                    }
                }
                this.lastFailureCode = safeCacheCode(error.code);
                console.warn(`[PUBLIC_CACHE] ${this.lastFailureCode} view=${request.view} circuit=${Date.now() < this.cooldownUntil ? 'global' : 'scoped'} pending=${this.inflight.size}`);
                await this.persist();
                throw unavailable(this.lastFailureCode);
            }
        });
        this.inflight.set(key, task);
        this.queue = task.catch(() => {});
        task.finally(() => this.inflight.delete(key)).catch(() => {});
        return task;
    }

    async readWithLiveState(key, query, entry, age, dirty) {
        const listing = ['home', 'browse', 'seller', 'featured'].includes(query.view);
        const staticLimit = query.view === 'detail-live' ? 2000 : MAX_AGE_MS;
        if (query.view === 'detail-live') {
            const shared = this.liveStates.get(query.id);
            if (shared && Date.now() - shared.at <= 2000 && !this.changed(query, shared.revision)) {
                entry = { data: { privacy_version: 1, shared_cache_version: CACHE_VERSION, rows: [shared.row], bids: [], total: 1, server_time: shared.server_time },
                    storedAt: shared.at, revision: shared.revision };
                age = Date.now() - shared.at; dirty = false;
            }
        }
        // Rebuild membership/order at the existing 30s cadence, not on every
        // individual bid. No stale page claims an exact current ranking/total.
        if (!entry || age > staticLimit || query.view === 'detail-live' && dirty || listing && age > FRESH_MS) {
            try { entry = await this.refresh(key, query); age = Math.max(0, Date.now() - entry.storedAt); dirty = false; }
            catch (error) {
                if (!entry || age > MAX_AGE_MS) return Response.json(cacheErrorBody(error.code), {
                    status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
            }
        }
        if (query.view === 'detail-static') return Response.json({ ...entry.data,
            rows: entry.data.rows.map(unavailableRow),
            public_snapshot: { captured_at: new Date(entry.storedAt).toISOString(), age_seconds: Math.floor(age / 1000),
                live_mode: true, live_unavailable: true, delayed: false },
        }, { headers: { 'Cache-Control': 'no-store', 'X-Khub-Cache': 'CATALOGUE', 'X-Content-Type-Options': 'nosniff' } });
        let data = entry.data;
        let live;
        const ids = [...new Set(data.rows.map(row => row.id))].sort();
        if (query.view === 'detail-live') {
            if (age <= 2000 && !this.changed(query, entry.revision)) {
                live = { ...data, server_time: new Date(Date.parse(data.server_time) + age).toISOString() };
                for (const row of data.rows) this.liveStates.set(row.id, { row, at: entry.storedAt, revision: entry.revision, server_time: data.server_time });
                while (this.liveStates.size > 256 || jsonBytes([...this.liveStates]) > MAX_BYTES / 4) this.liveStates.delete(this.liveStates.keys().next().value);
            }
        } else if (!ids.length) live = { ...data, rows: [] };
        else {
            const missing = ids.filter(id => {
                const cached = this.liveStates.get(id);
                return !cached || Date.now() - cached.at > 2000
                    || this.changed({ view: 'batch-live', ids: [id] }, cached.revision);
            });
            try {
                if (missing.length) {
                    const liveRequest = { view: 'batch-live', ids: missing };
                    const liveKey = JSON.stringify(liveRequest);
                    let liveEntry = this.entries.get(liveKey);
                    if (!liveEntry || Date.now() - liveEntry.storedAt > 2000 || this.changed(liveRequest, liveEntry.revision)) {
                        liveEntry = await this.refresh(liveKey, liveRequest);
                    }
                    if (Date.now() - liveEntry.storedAt <= 2000 && !this.changed(liveRequest, liveEntry.revision)) {
                        for (const row of liveEntry.data.rows) this.liveStates.set(row.id, {
                            row, at: liveEntry.storedAt, revision: liveEntry.revision, server_time: liveEntry.data.server_time,
                        });
                        while (this.liveStates.size > 256 || jsonBytes([...this.liveStates]) > MAX_BYTES / 4) this.liveStates.delete(this.liveStates.keys().next().value);
                    }
                }
            } catch { /* A failed batch must not hide other verified cached states. */ }
            const rows = [];
            let serverTime;
            for (const id of ids) {
                const cached = this.liveStates.get(id);
                if (cached && Date.now() - cached.at <= 2000 && !this.changed({ view: 'batch-live', ids: [id] }, cached.revision)) {
                    rows.push(cached.row);
                    const adjustedTime = new Date(Date.parse(cached.server_time) + Math.max(0, Date.now() - cached.at)).toISOString();
                    if (!serverTime || adjustedTime < serverTime) serverTime = adjustedTime;
                }
            }
            if (rows.length) live = { rows, server_time: serverTime };
        }
        const orderingDelayed = listing && (dirty || this.changed(query, entry.revision) || Date.now() - entry.storedAt > FRESH_MS);
        data = overlayLive(data, live, { orderingDelayed, unavailable: !live });
        const elapsed = Math.max(0, Date.now() - entry.storedAt);
        return Response.json({ ...data,
            public_snapshot: { ...data.public_snapshot, captured_at: new Date(entry.storedAt).toISOString(),
                age_seconds: Math.floor(elapsed / 1000), live_mode: true, delayed: orderingDelayed || data.public_snapshot.live_unavailable },
        }, { headers: { 'Cache-Control': 'no-store', 'X-Khub-Cache': live ? orderingDelayed ? 'LIVE-DELAYED-ORDER' : 'LIVE' : 'CATALOGUE-ONLY',
            'X-Khub-Snapshot-Age': String(Math.floor(elapsed / 1000)), 'X-Content-Type-Options': 'nosniff' } });
    }

    async fetch(request) {
        if (request.method === 'POST' && new URL(request.url).pathname === '/invalidate') return this.invalidate(request);
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { 'Cache-Control': 'no-store', Allow: 'GET' } });
        let query;
        try { query = publicRequest(request.url); }
        catch { return Response.json({ error: 'Invalid public listing request.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
        const key = JSON.stringify(query);
        let entry = this.entries.get(key);
        const age = entry ? Date.now() - entry.storedAt : Infinity;
        const detail = query.view.startsWith('detail-') || query.view === 'featured';
        const ttl = query.view === 'detail-live' ? 2000 : query.view === 'featured' ? 30000 : 300000;
        const dirty = entry && this.changed(query, entry.revision || '0');
        let state = 'HIT';
        const expiredFeature = query.view === 'featured' && entry?.data.rows.some(row => Date.parse(row.bid_deadline || row.end_time) <= Date.parse(entry.data.server_time) + age);
        // Versioned rollout: deploy SQL and the unavailable-state frontend
        // before enabling this flag. Legacy behavior remains available otherwise.
        if (this.env.LIVE_AUCTION_STATE === 'true' && request.headers.get('X-Khub-Live-State') === '1' && query.view !== 'banner') {
            return this.readWithLiveState(key, query, entry, age, dirty);
        }
        if (expiredFeature || (!detail && dirty) || age > (detail ? ttl : query.view === 'banner' ? FRESH_MS : MAX_AGE_MS)) {
            try { entry = await this.refresh(key, query); state = dirty ? 'REVALIDATED' : 'MISS'; }
            catch (error) { return Response.json(cacheErrorBody(error.code), { status: 503,
                headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } }); }
            // An invalidation can arrive while the refreshed snapshot is persisted.
            // Never return that older generation as a successful fresh response.
            if (!detail && this.changed(query, entry.revision || '0')) return Response.json({ error: unavailable().message }, {
                status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
            });
        } else if (!detail && age > FRESH_MS && age <= MAX_AGE_MS) {
            state = 'STALE';
            this.ctx.waitUntil(this.refresh(key, query).catch(() => {}));
        }
        const elapsed = Math.max(0, Date.now() - entry.storedAt);
        return Response.json({ ...entry.data,
            // A cached response must never wind auction clocks back to its fetch time.
            server_time: new Date(Date.parse(entry.data.server_time) + elapsed).toISOString(),
            public_snapshot: { captured_at: new Date(entry.storedAt).toISOString(), age_seconds: Math.floor(elapsed / 1000),
                delayed: elapsed >= 120000 || Boolean(this.blocked(query)) },
        }, { headers: { 'Cache-Control': 'no-store', 'X-Khub-Cache': state,
            'X-Khub-Snapshot-Age': String(Math.floor(elapsed / 1000)), 'X-Content-Type-Options': 'nosniff' } });
    }
}

export default { fetch() { return new Response('Not found', { status: 404 }); } };
