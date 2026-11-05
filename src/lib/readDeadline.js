import { trafficPressure } from './trafficPressure.js';
// Bound display reads only. Never race a financial write against this deadline.
export async function withReadDeadline(read, { signal, milliseconds = 12000 } = {}) {
    const started = Date.now();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let timer;
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort(Object.assign(
            new Error('Auctions are taking too long to load. Please retry shortly.'),
            { name: 'TimeoutError', code: 'KHUB_READ_TIMEOUT' },
        )), milliseconds);
    });
    try {
        if (controller.signal.aborted) return await aborted;
        const result = await Promise.race([read(controller.signal), aborted]);
        trafficPressure.observe({ milliseconds: Date.now() - started, failed: Boolean(result?.error) });
        return result;
    } catch (error) {
        if (!signal?.aborted) trafficPressure.observe({ milliseconds: Date.now() - started, failed: true });
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', onAbort);
    }
}
