import { supabase } from './supabase';

const reads = new Map();
export const BARTER_MINIMUM_MARKET_VALUE = 40_000_000;
export const BARTER_MAX_VALUE = 20_000_000_000;
export async function barterRpc(name, args = {}) {
    if (!supabase) throw new Error('The trading service is not configured.');
    let request = supabase.rpc(name, args);
    if (name.startsWith('read_') && request.abortSignal) request = request.abortSignal(AbortSignal.timeout(15000));
    const { data, error } = await request;
    if (error) throw new Error(error.message);
    return data;
}
export function readBarter(scope, name, args) {
    const key = JSON.stringify([scope, name, args]);
    const cached = reads.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const entry = { expires: Date.now() + 10000 };
    entry.promise = barterRpc(name, args).catch(error => { if (reads.get(key) === entry) reads.delete(key); throw error; });
    if (reads.size > 80) reads.clear();
    reads.set(key, entry);
    return entry.promise;
}
export function invalidateBarter() {
    reads.clear();
    globalThis.dispatchEvent?.(new Event('barter-updated'));
}
export async function writeBarter(name, args) {
    // Writes are never retried automatically. Reads reconcile uncertain outcomes.
    try { return await barterRpc(name, args); }
    finally { invalidateBarter(); }
}
export function offerValue(meat, items, prices) {
    if (!Number.isSafeInteger(meat) || meat < 0) return null;
    let total = BigInt(meat);
    for (const item of items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) return null;
        const quote = prices.get(item.id);
        if (!quote?.available || quote.readFailed || !Number.isSafeInteger(quote.price_meat) || quote.price_meat <= 0
            || !Number.isFinite(Date.parse(quote.checked_at)) || !Number.isFinite(Date.parse(quote.observed_at))
            || Date.parse(quote.checked_at) > Date.now() || Date.parse(quote.observed_at) > Date.parse(quote.checked_at)
            || Date.now() - Math.min(Date.parse(quote.checked_at), Date.parse(quote.observed_at)) >= 26 * 3600000) return null;
        total += BigInt(quote.price_meat) * BigInt(item.quantity);
    }
    return total > BigInt(BARTER_MAX_VALUE) ? null : Number(total);
}
export function offerDescription(offer) {
    return [...(offer.meat ? [`${offer.meat.toLocaleString('en-US')} Meat`] : []),
        ...offer.items.map(item => `${item.quantity > 1 ? `${item.quantity.toLocaleString('en-US')} × ` : ''}${item.name}`)].join(' + ');
}
