import { mkdir, readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { parseEnv } from 'node:util';
import { assertNoPrivateCredentials } from './assetSecurity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = fileURLToPath(new URL('../exports/khub-bot.tar.gz', import.meta.url));
await mkdir(new URL('../exports/', import.meta.url), { recursive: true });
// Only these files can enter the archive. Credentials, dependencies, runtime
// state, and previous exports are never included, even when present locally.
const files = [
    'package.json', 'package-lock.json', '.env.example', '.gitignore', '.dockerignore',
    'Dockerfile', 'compose.yaml', 'README.md', 'DEPLOYMENT.md', 'ITEM_CATALOG.md', 'MESSAGES.md', 'OPERATIONS.md', 'src', 'catalog',
    'supabase', 'tools', 'tests/escrow.test.mjs', 'tests/operator-logs.test.mjs', 'tests/mail-diagnostics.test.mjs', 'tests/catalog.test.mjs', 'tests/catalog-refresh.test.mjs', 'tests/market-prices.test.mjs', 'tests/market_prices_database_test.py', 'tests/completed_market_prices_database_test.py', 'tests/high_roller_market_database_test.py', 'tests/gift_expense_wording_database_test.py', 'tests/public_buy_sellers_database_test.py', 'tests/authenticated_buy_sellers_database_test.py', 'tests/closet.test.mjs', 'tests/chat-announcements.test.mjs', 'tests/bundle-security.test.mjs', 'tests/rollover.test.mjs', 'tests/financial.test.mjs', 'tests/accounts.test.mjs', 'tests/sent-mail.test.mjs', 'tests/receipt-time.test.mjs', 'tests/receipt_time_database_test.py', 'tests/anti_sniping_database_test.py', 'tests/direct_trade_reminders_database_test.py', 'tests/free_text_polls_database_test.py', 'tests/multiple_choice_polls_database_test.py', 'tests/escrow_starting_bid_cap_database_test.py', 'tests/closet_isolation_database_test.py', 'tests/inbox_deletion_database_test.py', 'tests/custom_ending_database_test.py', 'tests/ownership_filter_database_test.py', 'tests/poll_queue_database_test.py', 'tests/buy_orders_database_test.py', 'tests/buy_reservations_database_test.py', 'tests/fee_display_database_test.py', 'tests/site_updates_database_test.py', 'tests/cancel_buy_reservations_database_test.py', 'tests/auction_closure_database_test.py', 'tests/abandoned_drafts_database_test.py', 'tests/buy_fee_privacy_database_test.py', 'tests/trade_experience_database_test.py', 'tests/bid_help_database_test.py', 'tests/buy_gift_batches_database_test.py', 'tests/incoming_gifts_database_test.py', 'tests/gift_isolation_database_test.py', 'tests/incoming-gifts.test.mjs', 'tests/supervisor.test.mjs', 'tests/fixtures', 'tests/database_test.py', 'tests/tiered_fees_database_test.py', 'tests/hybrid_bid_increments_database_test.py', 'tests/hot_auctions_database_test.py', 'tests/escrow_expiry_database_test.py', 'tests/polls_database_test.py',
];
// Guard the allowlist's contents too: a credential accidentally pasted into src/
// or a nested private directory must not enter an otherwise safe upload bundle.
let settings = {};
try { settings = parseEnv(await readFile(join(root, '.env'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const configuredSecrets = ['SUPABASE_SERVICE_ROLE_KEY', 'KOL_PASSWORD']
    .filter(name => settings[name]?.length >= 8).map(name => ({ name, value: settings[name] }));
async function inspect(relative) {
    const path = join(root, relative);
    const info = await lstat(path);
    const name = basename(path);
    if (info.isSymbolicLink() || info.isDirectory() && /^(?:keys|data|exports|\.git|\.ssh|\.aws|backups?)$/i.test(name)
        || info.isFile() && (/^\.env(?:\..*)?$/.test(name) && name !== '.env.example' || /\.(?:key|pem|p12|pfx|sqlite3?|db|dump|tar\.gz|tgz|zip)$/i.test(name))) {
        throw new Error(`Private or unsafe bundle path ${relative}. Packaging blocked.`);
    }
    if (info.isDirectory()) {
        await Promise.all((await readdir(path)).map(child => inspect(`${relative}/${child}`)));
    } else if (info.isFile()) {
        const content = await readFile(path);
        assertNoPrivateCredentials(content, relative);
        for (const secret of configuredSecrets) {
            if (content.includes(Buffer.from(secret.value))) throw new Error(`Configured ${secret.name} found in ${relative}. Packaging blocked.`);
        }
    }
}
await Promise.all(files.map(inspect));
// macOS attributes/AppleDouble entries are unnecessary on the Linux host and
// otherwise produce repeated LIBARCHIVE.xattr warnings during extraction.
const metadataOptions = process.platform === 'darwin' ? ['--no-xattrs'] : [];
const result = spawnSync('tar', [...metadataOptions, '-czf', destination, '-C', root, ...files], {
    stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Created ${destination}\nCredentials are excluded. Create .env privately on the server.`);
