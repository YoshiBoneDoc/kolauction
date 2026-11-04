// Isolated aggregate cache: bookmark writes never evict auction snapshots.
// Forward only public UUID batches, never cookies or viewer credentials.
export async function onRequest({ request, env }) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    if (!env.PUBLIC_AUCTION_CACHE) return Response.json({ error: 'Bookmark count cache is not configured.' }, { status: 503, headers });
    try {
        const id = env.PUBLIC_AUCTION_CACHE.idFromName('public-bookmarks-v1');
        const response = await env.PUBLIC_AUCTION_CACHE.get(id).fetch(new Request(`https://cache.internal/public-bookmark-counts${new URL(request.url).search}`));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch { return Response.json({ error: 'Bookmark counts unavailable.' }, { status: 503, headers }); }
}
