// One advisory metadata read shared by previews and explanations. No polling.
export function createEscrowPromotionService(client, events = globalThis.window, now = Date.now) {
    let snapshot = { scope: undefined, data: null }, generation = 0, pending = null, loadedAt = 0;
    const listeners = new Set();
    let users = 0, subscription, expiryTimer;
    const quotes = new Map();
    const emit = () => listeners.forEach(listener => listener());
    function setScope(scope) {
        if (snapshot.scope === scope) return;
        generation++; pending = null; loadedAt = 0; quotes.clear(); clearTimeout(expiryTimer);
        snapshot = { scope, data: null }; emit();
    }
    async function refresh(force = false) {
        if (!client || snapshot.scope === undefined) return;
        if (pending) return pending;
        if (!force && snapshot.data && now() - loadedAt < 30000 && (!snapshot.data.valid_until || now() < Date.parse(snapshot.data.valid_until))) return;
        const version = generation, scope = snapshot.scope;
        const request = Promise.resolve().then(() => client.rpc('escrow_fee_preview', { p_price: 0 })).then(({ data, error }) => {
            if (version !== generation || error) return;
            snapshot = { scope, data }; loadedAt = now(); quotes.clear(); emit();
            clearTimeout(expiryTimer);
            if (data?.valid_until && users) {
                const delay = Math.max(1, Math.min(2147483647, Date.parse(data.valid_until) - now() + 50));
                expiryTimer = setTimeout(() => { snapshot = { scope, data: null }; emit(); refresh(true); }, delay);
            }
        }).catch(() => { /* Failed advisory reads never authorize settlement. */ }).finally(() => {
            if (version === generation) pending = null;
        });
        pending = request;
        return request;
    }
    const focus = () => { if (users) refresh(true); };
    return {
        async quote({ price, quantity = 1, kind = 'sell', auctionId = null }) {
            const version = generation, scope = snapshot.scope;
            const key = JSON.stringify([scope, price, quantity, kind, auctionId]);
            const cached = quotes.get(key);
            if (cached && now() - cached.at < 10000) return cached.promise;
            const promise = Promise.resolve().then(() => client.rpc('escrow_fee_quote', {
                p_price: price, p_quantity: quantity, p_kind: kind, p_auction: auctionId,
            })).then(({ data, error }) => {
                if (error || version !== generation || scope !== snapshot.scope) throw new Error('Fee estimate unavailable.');
                if (!data || !/^\d+$/.test(data.fee)) throw new Error('Invalid fee quote.');
                return data;
            }).catch(error => { quotes.delete(key); throw error; });
            if (quotes.size >= 40) quotes.delete(quotes.keys().next().value);
            quotes.set(key, { promise, at: now() });
            return promise;
        },
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        activate(scope) {
            setScope(scope);
            if (users++ === 0) {
                events?.addEventListener('focus', focus);
                subscription = client?.auth.onAuthStateChange((_event, session) => {
                    setScope(session?.user?.id ?? null);
                    // Do not perform Supabase queries inside the auth callback.
                    queueMicrotask(() => { if (users) refresh(); });
                });
            }
            refresh();
            return () => {
                if (--users === 0) {
                    events?.removeEventListener('focus', focus);
                    subscription?.data.subscription.unsubscribe();
                    generation++; pending = null; clearTimeout(expiryTimer); quotes.clear();
                }
            };
        },
        refresh,
        invalidate() {
            generation++; pending = null; loadedAt = 0; quotes.clear(); clearTimeout(expiryTimer);
            snapshot = { scope: snapshot.scope, data: null }; emit();
            if (users) refresh(true);
        },
    };
}

// Historical November fixture calculator only; live UI quotes always use SQL.
export function promotionalPreviewFee(price, metadata) {
    if (!metadata || !Number.isSafeInteger(price) || price < 0) return null;
    if (!metadata.enabled) return null; // Caller uses the original schedule.
    if (BigInt(metadata.volume) < 20000000n) return 0;
    const total = BigInt(price), first = total < 1000000000n ? total : 1000000000n;
    return Number((first * 200n + (total - first) * 100n) / 10000n);
}
