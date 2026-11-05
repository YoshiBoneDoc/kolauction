import { onRequest as bookmarkCounts } from '../../functions/api/public-bookmark-counts.js';
import { onRequest as publicCommitment } from '../../functions/api/public-raffle-commitment.js';
import { itemCatalog } from './itemCatalog.js';
import { runMaintenance } from './maintenance.js';
import { onRequest as publicAuctions } from '../../functions/api/public-auctions.js';
import { onRequest as publicBanner } from '../../functions/api/public-banner.js';
import { onRequestGet as giveawayImage } from '../../functions/api/giveaway-image.js';
import { onRequest as invalidateAuctions } from '../../functions/api/public-auctions/invalidate.js';

// Reuse the existing handlers: the same privacy, signing and method checks apply
// to Workers Static Assets and to any retained Pages deployment.
const routes = new Map([
    ['/api/public-bookmark-counts', bookmarkCounts],
    ['/api/public-auctions', publicAuctions],
    ['/api/public-banner', publicBanner],
    ['/api/public-raffle-commitment', publicCommitment],
    ['/api/giveaway-image', giveawayImage],
    ['/api/public-auctions/invalidate', invalidateAuctions],
]);

export default {
    async scheduled(event, env) { await runMaintenance(event, env); },
    async fetch(request, env, ctx) {
        const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
        if (pathname === '/api/item-catalog') return itemCatalog(request, env, ctx);
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
