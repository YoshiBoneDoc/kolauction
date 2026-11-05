// Serialized, visible-page-only summary reads. Never requests ticket totals/proof.
export function watchRaffleCommitment({ read, onValue, onError, document, window, timers = globalThis, now = Date.now, random = Math.random, endsAt }) {
    let stopped = false, running = false, timer, finished = false, failures = 0, nextAt = 0;
    const schedule = delay => {
        timers.clearTimeout(timer);
        if (!stopped && !finished && !document.hidden) timer = timers.setTimeout(update, delay);
    };
    async function update() {
        if (stopped || running || finished || document.hidden) return;
        running = true;
        try {
            const value = await read();
            if (stopped) return;
            onValue(value);
            failures = 0;
            finished = value?.complete || ['cancelled', 'empty'].includes(value?.state) || value?.required === false;
        } catch { failures++; if (!stopped) onError(); }
        finally {
            running = false;
            const untilClose = Date.parse(endsAt) - now();
            const base = failures ? Math.min(300000, 10000 * 2 ** Math.min(failures - 1, 5))
                : untilClose > 0 ? Math.min(60000, Math.max(5000, untilClose)) : 5000;
            const delay = Math.ceil(base * (1 + 0.2 * random()));
            nextAt = now() + delay;
            schedule(delay);
        }
    }
    function wake() {
        // Focus never bypasses the normal cadence or a failure cooldown.
        if (!running) schedule(Math.max(0, nextAt - now()));
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    void update();
    return () => { stopped = true; timers.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
}
