// Serialized, visible-page-only summary reads. Never requests ticket totals/proof.
export function watchRaffleCommitment({ read, onValue, onError, document, window, timers = globalThis, now = Date.now, endsAt }) {
    let stopped = false, running = false, timer, finished = false;
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
            finished = value?.complete || ['cancelled', 'empty'].includes(value?.state) || value?.required === false;
        } catch { if (!stopped) onError(); }
        finally {
            running = false;
            const untilClose = Date.parse(endsAt) - now();
            schedule(untilClose > 0 ? Math.min(60000, Math.max(5000, untilClose)) : 5000);
        }
    }
    function wake() { if (!running) { timers.clearTimeout(timer); void update(); } }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    void update();
    return () => { stopped = true; timers.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
}
