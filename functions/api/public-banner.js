// Separate named cache object: bids do not evict the announcement, and banner
// refreshes cannot queue behind a burst of auction searches.
export async function onRequest({ request, env }) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    if (new URL(request.url).search) return Response.json({ error: 'Invalid banner request.' }, { status: 400, headers });
    if (!env.PUBLIC_AUCTION_CACHE) return Response.json({ error: 'Banner cache is not configured.' }, { status: 503, headers });
    try {
        const id = env.PUBLIC_AUCTION_CACHE.idFromName('public-banner-v1');
        const response = await env.PUBLIC_AUCTION_CACHE.get(id).fetch(new Request('https://cache.internal/public-banner'));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch { return Response.json({ error: 'Announcement unavailable.' }, { status: 503, headers }); }
}
