import { createBookmarkCountPreview } from './scripts/bookmarkCountPreview.mjs';
import { defineConfig, loadEnv } from 'vite'
import { cwd } from 'node:process'
import react from '@vitejs/plugin-react'
import { onRequestGet as giveawayImage } from './functions/api/giveaway-image.js'
import { itemCatalog } from './workers/site/itemCatalog.js'
import { assertPublicEnvironment, assetSecurityPlugin } from './scripts/assetSecurity.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  assertPublicEnvironment(loadEnv(mode, cwd(), 'VITE_'))
  return {
    plugins: [react(), assetSecurityPlugin(), {
      name: 'giveaway-image-preview',
      configureServer(server) {
        const publicEnv = loadEnv(mode, cwd(), 'VITE_');
        const bookmarkCounts = createBookmarkCountPreview(publicEnv);
        server.middlewares.use('/api/public-auctions', async (req, res) => {
          try {
            const url = new URL(req.originalUrl || `/api/public-auctions${req.url}`, 'http://localhost');
            const response = await bookmarkCounts(new Request(url, {
              method: req.method,
              headers: req.headers['x-khub-live-state'] === '1' ? { 'X-Khub-Live-State': '1' } : {},
            }));
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(new Uint8Array(await response.arrayBuffer()));
          } catch {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Public auctions unavailable.' }));
          }
        });
        server.middlewares.use('/api/item-catalog', async (req, res) => {
          try {
            const request = new Request(new URL(req.originalUrl || req.url, `http://${req.headers.host || 'localhost'}`), { method: req.method });
            const response = await itemCatalog(request, {
              SUPABASE_URL: publicEnv.VITE_SUPABASE_URL,
              SUPABASE_PUBLISHABLE_KEY: publicEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
            }, { waitUntil() {} }, fetch, null);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(new Uint8Array(await response.arrayBuffer()));
          } catch {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Catalogue unavailable.' }));
          }
        });
        server.middlewares.use('/api/public-bookmark-counts', async (req, res) => {
          try {
            const response = await bookmarkCounts(new Request(new URL(req.url, 'http://localhost'), { method: req.method }));
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(new Uint8Array(await response.arrayBuffer()));
          } catch { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bookmark counts unavailable.' })); }
        });
        server.middlewares.use('/api/giveaway-image', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          try {
            const response = await giveawayImage({ request: new Request(new URL(req.url, 'http://localhost')) });
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(new Uint8Array(await response.arrayBuffer()));
          } catch { res.writeHead(502); res.end('Image unavailable'); }
        });
      },
    }],
    build: {
      outDir: 'build', // Change output directory to 'build'
    },
  }
})
