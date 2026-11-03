const inFlight = new Map();
let cooldownUntil = 0;
// Existing Cloudflare edge cache, outside the live auction queue. Versioned
// bodies are precomputed by catalogue sync; no per-request JSON aggregation.
export async function itemCatalog(request, env, ctx, fetcher = fetch, cache = globalThis.caches?.default) {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const url = new URL(request.url);
    const version = url.searchParams.get('version');
    if ([...url.searchParams.keys()].some(key => key !== 'version') || version !== null && !/^[a-f0-9]{64}$/.test(version)) return new Response('Invalid catalogue version', { status: 400 });
    const key = new Request(`${url.origin}/api/item-catalog${version ? `?version=${version}` : ''}`);
    const cached = await cache?.match(key);
    if (cached) return conditional(cached, request);
    try {
        const base = new URL(env.SUPABASE_URL);
        if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Invalid origin');
        const apiKey = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
        let anonymous = apiKey?.startsWith('sb_publishable_');
        if (!anonymous) {
            try { anonymous = JSON.parse(atob(apiKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role === 'anon'; } catch { /* Fail closed. */ }
        }
        if (!anonymous) throw new Error('Invalid public catalogue key');
        const headers = { apikey: apiKey, 'Content-Type': 'application/json' };
        if (apiKey?.startsWith('ey')) headers.Authorization = `Bearer ${apiKey}`;
        const originKey = `${base.origin}:${version || 'manifest'}`;
        if (Date.now() < cooldownUntil) throw new Error('Catalogue cooling down');
        let pending = inFlight.get(originKey);
        if (!pending) {
            if (inFlight.size >= 2) throw new Error('Catalogue busy');
            pending = (async () => {
                const result = await fetcher(new URL(`/rest/v1/rpc/${version ? 'read_item_catalog_snapshot' : 'read_item_catalog_manifest'}`, base), {
                    method: 'POST', redirect: 'manual', headers, body: JSON.stringify(version ? { p_version: version } : {}),
                    signal: AbortSignal.timeout(3000),
                });
                if (!result.ok) throw new Error('Catalogue unavailable');
                return await result.json();
            })().catch(error => { cooldownUntil = Date.now() + 30000; throw error; });
            inFlight.set(originKey, pending);
            pending.finally(() => inFlight.delete(originKey)).catch(() => {});
        }
        const data = await pending;
        if (!data && version) {
            if (cache?.delete) ctx.waitUntil(cache.delete(new Request(`${url.origin}/api/item-catalog`)));
            return new Response('Catalogue version unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }
        if (!data || version && (!data.ready || !Array.isArray(data.items))
            || !version && (!/^[a-f0-9]{64}$/.test(data.version) || data.url !== `/api/item-catalog?version=${data.version}`)) throw new Error('Invalid catalogue');
        const response = Response.json(data, { headers: {
            'Cache-Control': version ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
            ETag: `"${version || data.version}"`, 'X-Content-Type-Options': 'nosniff',
        } });
        if (cache) ctx.waitUntil(cache.put(key, response.clone()));
        return conditional(response, request);
    } catch {
        // Deployment or origin failures keep the checked-in static catalogue usable.
        if (!version && env.ASSETS) return env.ASSETS.fetch(new Request(new URL('/catalog/manifest.json', url)));
        return Response.json({ error: 'Catalogue unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
function conditional(response, request) {
    return request.headers.get('If-None-Match') === response.headers.get('ETag')
        ? new Response(null, { status: 304, headers: response.headers }) : response;
}
