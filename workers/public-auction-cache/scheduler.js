// One origin at a time. Live work gets priority, but after three live reads an
// older catalogue request gets a turn. No additional database concurrency.
export function createOriginScheduler() {
    const pending = [];
    let running = false, liveStreak = 0;
    function pump() {
        if (running || !pending.length) return;
        let index = pending.findIndex(job => job.live);
        const catalogue = pending.findIndex(job => !job.live);
        if (index < 0 || liveStreak >= 3 && catalogue >= 0) index = catalogue;
        const job = pending.splice(index, 1)[0];
        liveStreak = job.live ? liveStreak + 1 : 0;
        running = true;
        Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { running = false; pump(); });
    }
    return (run, live) => new Promise((resolve, reject) => {
        pending.push({ run, live, resolve, reject });
        pump();
    });
}
