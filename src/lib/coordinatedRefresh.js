// Store timestamps and opaque change signals only, never profiles or credentials.
export async function refreshScope(id) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function coordinatedRefresh(key, refresh, { force = false, maxAge = 60000, now = Date.now, locks = globalThis.navigator?.locks, storage } = {}) {
    if (!storage) { try { storage = globalThis.localStorage; } catch { return refresh(); } }
    if (!locks || !storage) return refresh();
    const run = async () => {
        let last;
        try { last = Number(storage.getItem(key)); } catch { return refresh(); }
        if (!force && last > 0 && now() >= last && now() - last < maxAge) return true;
        const success = await refresh();
        if (success !== false) { try { storage.setItem(key, String(now())); } catch { /* Tab-local fallback. */ } }
        return success;
    };
    let started = false;
    try { return await locks.request(key, () => { started = true; return run(); }); }
    catch (error) { if (!started) return refresh(); throw error; }
}
