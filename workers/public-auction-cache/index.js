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
        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get(STORE_KEY);
            this.revision = validRevision(saved?.revision) ? saved.revision : '0';
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
        await this.ctx.storage.put(STORE_KEY, { entries: [...this.entries], cooldownUntil: this.cooldownUntil, revision: this.revision, failureCode: this.lastFailureCode });
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
        if (BigInt(payload.revision) > BigInt(this.revision)) {
            this.revision = payload.revision;
            await this.persist();
        }
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
                method: 'POST', headers, body: JSON.stringify(args), redirect: 'error',
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
        if (response.headers.has('set-cookie')) throw unavailable('CACHE_INVALID_RESPONSE');
        let result;
        try { result = publicProjection(JSON.parse(text), request); }
        catch { throw unavailable('CACHE_INVALID_RESPONSE'); }
        result.server_time = new Date(Date.parse(result.server_time) + (Date.now() - startedAt) / 2).toISOString();
        return result;
    }

    refresh(key, request) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        if (Date.now() < this.cooldownUntil) return Promise.reject(unavailable(this.lastFailureCode));
        if (this.inflight.size >= MAX_PENDING) return Promise.reject(unavailable('CACHE_QUEUE_FULL'));
        const task = this.queue.then(async () => {
            if (Date.now() < this.cooldownUntil) throw unavailable(this.lastFailureCode);
            try {
                let entry;
                for (let attempt = 0; attempt < 2; attempt++) {
                    // Rate limit retries as well as distinct query keys.
                    const delay = Math.max(0, this.lastOriginAt + 1000 - Date.now());
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    this.lastOriginAt = Date.now();
                    const revision = this.revision;
                    const data = await this.readOrigin(request);
                    if (revision !== this.revision) continue;
                    entry = { data, storedAt: Date.now(), revision };
                    break;
                }
                if (!entry) throw changedDuringRead();
                this.entries.delete(key);
                this.entries.set(key, entry);
                while (this.entries.size > MAX_ENTRIES || jsonBytes([...this.entries]) > MAX_BYTES) {
                    this.entries.delete(this.entries.keys().next().value);
                }
                this.cooldownUntil = 0;
                this.lastFailureCode = 'CACHE_UNAVAILABLE';
                await this.persist();
                return entry;
            } catch (error) {
                // A failing database gets breathing room, not a retry from every visitor.
                if (error.code !== 'CACHE_CHANGED') this.cooldownUntil = Date.now() + 30000;
                this.lastFailureCode = safeCacheCode(error.code);
                console.warn(`[PUBLIC_CACHE] ${this.lastFailureCode} view=${request.view}`);
                await this.persist();
                throw unavailable(this.lastFailureCode);
            }
        });
        this.inflight.set(key, task);
        this.queue = task.catch(() => {});
        task.finally(() => this.inflight.delete(key)).catch(() => {});
        return task;
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
        const dirty = entry && (entry.revision || '0') !== this.revision;
        let state = 'HIT';
        if (dirty || age > (query.view === 'banner' ? FRESH_MS : MAX_AGE_MS)) {
            try { entry = await this.refresh(key, query); state = dirty ? 'REVALIDATED' : 'MISS'; }
            catch (error) { return Response.json(cacheErrorBody(error.code), { status: 503,
                headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } }); }
            // An invalidation can arrive while the refreshed snapshot is persisted.
            // Never return that older generation as a successful fresh response.
            if ((entry.revision || '0') !== this.revision) return Response.json({ error: unavailable().message }, {
                status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
            });
        } else if (age > FRESH_MS && age <= MAX_AGE_MS) {
            state = 'STALE';
            this.ctx.waitUntil(this.refresh(key, query).catch(() => {}));
        }
        const elapsed = Math.max(0, Date.now() - entry.storedAt);
        return Response.json({ ...entry.data,
            // A cached response must never wind auction clocks back to its fetch time.
            server_time: new Date(Date.parse(entry.data.server_time) + elapsed).toISOString(),
            public_snapshot: { captured_at: new Date(entry.storedAt).toISOString(), age_seconds: Math.floor(elapsed / 1000),
                delayed: elapsed >= 120000 || Date.now() < this.cooldownUntil },
        }, { headers: { 'Cache-Control': 'no-store', 'X-Khub-Cache': state,
            'X-Khub-Snapshot-Age': String(Math.floor(elapsed / 1000)), 'X-Content-Type-Options': 'nosniff' } });
    }
}

export default { fetch() { return new Response('Not found', { status: 404 }); } };
