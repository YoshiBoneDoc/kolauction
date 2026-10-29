import { readInvalidation } from '../../../workers/public-auction-cache/invalidation.js';

// Only a tiny signed revision crosses this endpoint. No bid row, user identity,
// cookie or browser authorization header is forwarded or stored.
export async function onRequest({ request, env }) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
    let payload;
    try { payload = await readInvalidation(request); }
    catch { return Response.json({ error: 'Invalid notification.' }, { status: 400, headers }); }
    if (!env.PUBLIC_AUCTION_CACHE) return Response.json({ error: 'Cache is not configured.' }, { status: 503, headers });
    try {
        const id = env.PUBLIC_AUCTION_CACHE.idFromName('public-auctions-v1');
        const response = await env.PUBLIC_AUCTION_CACHE.get(id).fetch(new Request('https://cache.internal/invalidate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        }));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch {
        return Response.json({ error: 'Notification unavailable.' }, { status: 503, headers });
    }
}
