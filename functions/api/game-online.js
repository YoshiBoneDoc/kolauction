// Count only connected game characters; website visitors do not create players.
export async function onRequest({ request }) {
    const headers = { 'Cache-Control': 'public, max-age=30', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
    try {
        const response = await fetch('https://maincloud.spacetimedb.com/v1/database/khub-mmo/sql', {
            method: 'POST', headers: { 'Content-Type': 'text/plain' },
            body: 'SELECT online FROM player WHERE online = true', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Presence unavailable');
        const result = await response.json();
        if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].rows) || !result[0].rows.every(row => Array.isArray(row) && row.length === 1 && row[0] === true)) throw new Error('Invalid presence response');
        return Response.json({ count: result[0].rows.length }, { headers });
    } catch {
        return Response.json({ error: 'Presence unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
