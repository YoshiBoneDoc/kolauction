// Local, bounded observations of display reads only. Never changes write policy.
export function createTrafficPressure({ now = Date.now } = {}) {
    let samples = [], busyUntil = 0, healthy = 0;
    return {
        observe({ milliseconds, failed = false }) {
            const at = now();
            samples = [...samples.filter(s => at - s.at < 30000), { at, bad: failed || milliseconds >= 2500 }].slice(-20);
            if (failed || milliseconds >= 2500) {
                healthy = 0;
                if (samples.filter(s => s.bad).length >= 3) busyUntil = at + 60000;
            } else if (milliseconds < 1000) healthy++;
            if (busyUntil && at >= busyUntil && healthy >= 5) { busyUntil = 0; samples = []; }
        },
        busy() { return busyUntil > 0; },
        delay(normal, busy = normal * 3) { return busyUntil ? busy : normal; },
    };
}
export const trafficPressure = createTrafficPressure();
