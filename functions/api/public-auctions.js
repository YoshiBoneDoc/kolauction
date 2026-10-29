// Forward ONLY the canonical public query. Cookies, authorization, request bodies,
// arbitrary headers and caller-selected object names never reach the shared cache.
import { cacheErrorBody } from '../../workers/public-auction-cache/errors.js';
export async function onRequest({ request, env }) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    if (!env.PUBLIC_AUCTION_CACHE) return Response.json({ error: 'Public listing cache is not configured.', code: 'CACHE_BINDING_MISSING' }, { status: 503, headers });
    try {
        const id = env.PUBLIC_AUCTION_CACHE.idFromName('public-auctions-v1');
        const stub = env.PUBLIC_AUCTION_CACHE.get(id);
        const url = new URL(request.url);
        const response = await stub.fetch(new Request(`https://cache.internal/public-auctions${url.search}`));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch {
        return Response.json(cacheErrorBody('CACHE_BINDING_ERROR'), { status: 503, headers: { ...headers, 'Retry-After': '30' } });
    }
}
