import { trafficPressure } from './trafficPressure.js';
// Per-viewer polling only. No shared/persistent profile or voting data.
export function startPrivateRefresh({ refresh, document, window, timers = globalThis, now = Date.now, random = Math.random, interval = 60000, refreshEvent = null }) {
    let stopped = false, running = false, failures = 0, timer, lastAttempt = -Infinity, retryAt = 0, reason = 'initial', lastSuccess = -Infinity, explicitQueued = false;
    const clear = () => timers.clearTimeout(timer);
    const schedule = ms => { clear(); if (!stopped && !document.hidden) timer = timers.setTimeout(update, ms); };
    async function update() {
        if (stopped || running || document.hidden) return;
        clear();
        if (now() < retryAt) { schedule(retryAt - now()); return; }
        running = true; lastAttempt = now();
        let success = false;
        try { success = await refresh(reason) !== false; reason = 'timer'; } catch { /* Caller owns its error UI. */ }
        finally {
            running = false;
            if (success) lastSuccess = now();
            failures = success ? 0 : failures + 1;
            const base = success ? trafficPressure.delay(typeof interval === 'function' ? interval() : interval) : Math.min(300000, 60000 * 2 ** Math.min(failures - 1, 3));
            const delay = Math.ceil(base * (1 + 0.2 * random()));
            retryAt = success ? 0 : now() + delay;
            if (explicitQueued) {
                explicitQueued = false; reason = 'event';
                schedule(Math.max(5000, retryAt - now()));
            } else schedule(delay);
        }
    }
    function wake(event) {
        const explicit = event?.type === refreshEvent;
        if (running) { if (explicit) explicitQueued = true; return; }
        reason = explicit ? 'event' : 'focus';
        clear();
        if (!stopped && !document.hidden && !running) {
            schedule(Math.max(0, retryAt - now(), Math.max(lastAttempt, lastSuccess) + (reason === 'event' ? 5000 : trafficPressure.delay(5000, 60000)) - now()));
        }
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    if (refreshEvent) window.addEventListener(refreshEvent, wake);
    schedule(0);
    return () => { stopped = true; clear(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); if (refreshEvent) window.removeEventListener(refreshEvent, wake); };
}
