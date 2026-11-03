const tasks = [
    { rpc: 'site_refresh_discovery', minute: 1 },
    { rpc: 'site_cleanup_activity', minute: 5 },
    { rpc: 'site_refresh_totals', minute: 30 },
];
// Local cooldown also protects the API if an outage prevents SQL from recording
// its durable per-task backoff. Database locks/due times handle isolate overlap.
let retryAt = 0;
export async function runMaintenance(event, env, fetcher = fetch) {
    if (env.SITE_MAINTENANCE_ENABLED !== 'true') return;
    const base = new URL(env.SUPABASE_URL);
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Invalid maintenance origin');
    if (!env.SITE_MAINTENANCE_TOKEN || !env.SUPABASE_PUBLISHABLE_KEY) throw new Error('Missing maintenance credentials');
    const at = event.scheduledTime ?? Date.now();
    if (Date.now() < retryAt) return;
    const minute = Math.floor(at / 60000);
    for (const task of tasks) {
        // Offset cleanup and totals so those two jobs never share a scheduled minute.
        const due = task.minute === 1 || minute % task.minute === (task.minute === 5 ? 2 : 4);
        if (!due) continue;
        try {
            const response = await fetcher(new URL(`/rest/v1/rpc/${task.rpc}`, base), {
                method: 'POST', redirect: 'manual',
                headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${env.SITE_MAINTENANCE_TOKEN}`, 'Content-Type': 'application/json' },
                body: '{}', signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) throw new Error('Maintenance RPC failed');
            const result = await response.json();
            if (!['ok', 'busy', 'deferred'].includes(result?.state)) throw new Error('Invalid maintenance result');
            console.log(`[MAINTENANCE] task=${task.rpc} state=${result.state}`);
            if (result.code) { retryAt = Date.now() + 300000; break; }
        } catch {
            // No secret, raw database error or request body enters logs.
            retryAt = Date.now() + 300000;
            console.warn(`[MAINTENANCE] task=${task.rpc} state=unavailable`);
            break;
        }
    }
}
