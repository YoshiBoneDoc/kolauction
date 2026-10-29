import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { assertPublicAssets } from './assetSecurity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Explicit build environment settings may disable caching for rollback. A
// Cloudflare build defaults to enabled, even if a local dotenv file says false.
const sharedCache = process.env.VITE_SHARED_AUCTION_CACHE ?? 'true';
if (!['true', 'false'].includes(sharedCache)) throw new Error('VITE_SHARED_AUCTION_CACHE must be true or false.');
console.log(`Cloudflare build: VITE_SHARED_AUCTION_CACHE=${sharedCache}`);
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'build'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SHARED_AUCTION_CACHE: sharedCache },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

// Public, non-secret proof of which flag was compiled into the deployed assets.
await writeFile(new URL('../build/khub-build.json', import.meta.url), JSON.stringify({
    runtime: 'cloudflare-workers', sharedAuctionCache: sharedCache === 'true',
}) + '\n');
await assertPublicAssets(fileURLToPath(new URL('../build/', import.meta.url)));
