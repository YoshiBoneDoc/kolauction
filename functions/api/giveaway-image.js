// Fixed upstream and strict paths prevent this public image cache from acting as a proxy.
export async function onRequestGet({ request }) {
    const params = new URL(request.url).searchParams;
    const path = params.get('path') || '';
    // The supplied wiki sprite is a fixed decorative asset, never a user-selected URL.
    const penguin = params.get('penguin') === '1';
    if (!penguin && !/^(?:itemimages|otherimages)(?:\/[A-Za-z0-9_-]+)+\.gif$/.test(path)) return new Response('Invalid image', { status: 400 });
    const filename = path.split('/').at(-1);
    const candidates = penguin
        ? ['https://wiki.kingdomofloathing.com/Special:Redirect/file/Shoppeng.gif', 'https://images.kingdomofloathing.com/otherimages/shoppeng.gif']
        : [`https://images.kingdomofloathing.com/${path}`, `https://wiki.kingdomofloathing.com/Special:Redirect/file/${encodeURIComponent(filename)}`];
    for (const url of candidates) {
        try {
            const upstream = await fetch(url, { cf: { cacheTtl: 86400 }, signal: AbortSignal.timeout(8000) });
            if (!upstream.ok || !/^image\//i.test(upstream.headers.get('Content-Type') || '')) continue;
            return new Response(upstream.body, { headers: { 'Content-Type': upstream.headers.get('Content-Type'), 'Cache-Control': 'public, max-age=86400' } });
        } catch { /* Try the other fixed artwork host. */ }
    }
    return new Response('Image unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
