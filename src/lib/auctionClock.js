let sample = null;
const listeners = new Set();
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

export function auctionNow() {
    return sample ? sample.serverAtResponse + monotonicNow() - sample.receivedAt : Date.now();
}

export function observeAuctionServerTime(serverTime, requestStartedAt) {
    const server = Date.parse(serverTime);
    const receivedAt = monotonicNow();
    if (!Number.isFinite(server) || !Number.isFinite(requestStartedAt)
        || requestStartedAt > receivedAt || sample && requestStartedAt < sample.requestStartedAt) return;
    sample = { requestStartedAt, receivedAt, serverAtResponse: server + (receivedAt - requestStartedAt) / 2 };
    for (const listener of listeners) listener();
}
export function auctionClockRequestStarted() { return monotonicNow(); }
export function subscribeAuctionClock(listener) { listeners.add(listener); return () => listeners.delete(listener); }
