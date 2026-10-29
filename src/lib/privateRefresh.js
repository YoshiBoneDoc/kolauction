// Per-viewer polling only. No shared/persistent profile or voting data.
export function startPrivateRefresh({ refresh, document, window, timers = globalThis, now = Date.now, random = Math.random }) {
    let stopped = false, running = false, failures = 0, timer, lastAttempt = -Infinity, retryAt = 0;
    const clear = () => timers.clearTimeout(timer);
    const schedule = ms => { clear(); if (!stopped && !document.hidden) timer = timers.setTimeout(update, ms); };
    async function update() {
        if (stopped || running || document.hidden) return;
        clear();
        if (now() < retryAt) { schedule(retryAt - now()); return; }
        running = true; lastAttempt = now();
        let success = false;
        try { success = await refresh() !== false; } catch { /* Caller owns its error UI. */ }
        finally {
            running = false;
            failures = success ? 0 : failures + 1;
            const base = success ? 60000 : Math.min(300000, 60000 * 2 ** Math.min(failures - 1, 3));
            const delay = Math.ceil(base * (1 + 0.2 * random()));
            retryAt = success ? 0 : now() + delay;
            schedule(delay);
        }
    }
    function wake() {
        clear();
        if (!stopped && !document.hidden && !running) {
            schedule(Math.max(0, retryAt - now(), lastAttempt + 5000 - now()));
        }
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    schedule(0);
    return () => { stopped = true; clear(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
}
