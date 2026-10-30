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
