// Public metadata only, using the existing bounded shared-cache scheduler.
export async function onRequest({ request, env }) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (url.searchParams.size !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '')) return Response.json({ error: 'Invalid commitment ID.' }, { status: 400, headers });
    try {
        if (!env.PUBLIC_AUCTION_CACHE) throw new Error();
        const object = env.PUBLIC_AUCTION_CACHE.idFromName('public-raffle-commitments-v1');
        const response = await env.PUBLIC_AUCTION_CACHE.get(object).fetch(new Request(`https://cache.internal/public-raffle-commitment?id=${id.toLowerCase()}`));
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    } catch { return Response.json({ error: 'Commitment unavailable.' }, { status: 503, headers: { ...headers, 'Retry-After': '30' } }); }
}
