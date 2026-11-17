// Count only connected game characters; website visitors do not create players.
export async function onRequest({ request }) {
    const headers = { 'Cache-Control': 'public, max-age=30', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
    try {
        const response = await fetch('https://maincloud.spacetimedb.com/v1/database/khub-mmo/route/online-count', {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Presence unavailable');
        const result = await response.json();
        if (!Number.isSafeInteger(result?.count) || result.count < 0) throw new Error('Invalid presence response');
        return Response.json({ count: result.count }, { headers });
    } catch {
        return Response.json({ error: 'Presence unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
