import { createBookmarkCountPreview } from './scripts/bookmarkCountPreview.mjs';
import { defineConfig, loadEnv } from 'vite'
import { cwd } from 'node:process'
import react from '@vitejs/plugin-react'
import { onRequestGet as giveawayImage } from './functions/api/giveaway-image.js'
import { assertPublicEnvironment, assetSecurityPlugin } from './scripts/assetSecurity.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  assertPublicEnvironment(loadEnv(mode, cwd(), 'VITE_'))
  return {
    plugins: [react(), assetSecurityPlugin(), {
      name: 'giveaway-image-preview',
      configureServer(server) {
        const bookmarkCounts = createBookmarkCountPreview(loadEnv(mode, cwd(), 'VITE_'));
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
