import { onRequest as publicAuctions } from '../../functions/api/public-auctions.js';
import { onRequest as publicBanner } from '../../functions/api/public-banner.js';
import { onRequest as invalidateAuctions } from '../../functions/api/public-auctions/invalidate.js';

// Reuse the existing handlers: the same privacy, signing and method checks apply
// to Workers Static Assets and to any retained Pages deployment.
const routes = new Map([
    ['/api/public-auctions', publicAuctions],
    ['/api/public-banner', publicBanner],
    ['/api/public-auctions/invalidate', invalidateAuctions],
]);

export default {
    async fetch(request, env) {
        const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
        const handler = routes.get(pathname);
        if (handler) return handler({ request, env });
        // API misses must never return the SPA HTML as a successful JSON read.
        if (pathname === '/api' || pathname.startsWith('/api/')) {
            return Response.json({ error: 'API route not found.' }, {
                status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
            });
        }
        if (!env.ASSETS) return new Response('Static assets unavailable.', { status: 503 });
        return env.ASSETS.fetch(request);
    },
};
