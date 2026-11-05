import { createPrivateCardCache } from './privateCardCache.js';
import { LIVE_FIELDS } from '../../workers/public-auction-cache/liveState.js';
// Shared public snapshots and private viewer context use separate transports.
// Never send the browser's JWT/cookies or private query parameters to Cloudflare.
export function createPublicAuctionReader(client, { enabled = false, fetch: fetcher = globalThis.fetch } = {}) {
    const details = new Map();
    const overlays = new Map();
    const cardCache = createPrivateCardCache(async (ids, signal) => {
        let query = client.rpc('read_auction_card_context', { p_ids: ids });
        if (signal && query.abortSignal) query = query.abortSignal(signal);
        const { data, error, status } = await query;
        if (error) throw Object.assign(new Error(error.message || 'Your auction details could not be refreshed.'), { code: error.code, status });
        return data;
    });
    let eligibility;
    let scope;
    let generation = 0;
    const invalidate = () => { generation++; eligibility = null; details.clear(); overlays.clear(); cardCache.clear(); };
    globalThis.window?.addEventListener('khub:ignore-list-changed', invalidate);
    async function affected(session) {
        const token = session?.access_token || session?.user?.id || (session ? 'signed-in' : 'anon');
        if (scope !== token) { scope = token; invalidate(); }
        if (!session) return false;
        if (!eligibility || Date.now() - eligibility.at >= 60000) {
            const revision = generation;
            const promise = client.rpc('read_ignore_relationships').then(({ data, error }) => {
                if (error) throw error;
                if (typeof data !== 'boolean') throw new Error('Invalid private visibility context.');
                return data;
            });
            eligibility = { at: Date.now(), promise };
            try { const result = await promise; if (revision !== generation) return affected(session); return result; }
            catch (error) { eligibility = null; throw error; }
        }
        return eligibility.promise;
    }
    return {
        async accepts(request) {
            if (request.fresh) { details.clear(); overlays.clear(); cardCache.clear(); }
            if (!enabled || !client || !['home', 'browse', 'seller', 'detail'].includes(request.view)
                || request.sellerId || request.excludeOwn || request.fresh && request.view !== 'detail' || request.summaryOnly
                || ['seller', 'detail'].includes(request.view) && !request.id) return false;
            // Personalized visibility must be applied before pagination and totals.
            const { data, error } = await client.auth.getSession();
            if (error) throw error;
            const needsEligibility = ['home', 'browse', 'seller'].includes(request.view)
                && request.trade !== 'escrow' && request.kind !== 'buy';
            const restricted = needsEligibility && await affected(data.session);
            if (data.session && ['browse', 'seller'].includes(request.view) && request.status === 'all') return false;
            if (restricted && ['home', 'browse', 'seller'].includes(request.view)
                && request.trade !== 'escrow' && request.kind !== 'buy') return false;
            return true;
        },
        async load(request) {
            if (request.view === 'detail') {
                const { data: auth, error: authError } = await client.auth.getSession();
                if (authError) throw authError;
                // Token scopes prevent reuse across sign-in, sign-out or authorization changes.
                const key = `${request.id}:${auth.session?.access_token || 'anon'}`;
                let context = details.get(key);
                const previous = context;
                // An existing published page can verify live data while private
                // context refreshes. Drafts never enter the public transport.
                const livePromise = previous?.data.rows.length && previous.data.rows[0].status !== 'pending_escrow'
                    ? this.load({ ...request, view: 'detail-live' }).then(data => ({ data }), error => ({ error })) : null;
                let authoritativeRead = false;
                const detailStatus = context?.data.rows[0]?.status;
                const privateTtl = detailStatus === 'active' ? 60000 : detailStatus === 'pending_escrow' ? 30000 : 120000;
                if (!context || Date.now() - context.at >= privateTtl) {
                    const full = !context || Date.now() - context.staticAt >= 300000 || context.data.rows[0]?.status !== 'active' || context.data.rows[0]?.auction_kind === 'buy';
                    let query = client.rpc(full ? 'read_auction_detail_static' : 'read_auction_viewer_context', { p_view: 'detail', p_id: request.id,
                        p_search: '', p_status: 'active', p_sort: 'ending', p_page: 1 });
                    if (request.signal && query.abortSignal) query = query.abortSignal(request.signal);
                    let { data, error } = await query;
                    if (error) throw error;
                    request.signal?.throwIfAborted();
                    if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || !Array.isArray(data.bids)) throw new Error('Invalid private auction detail.');
                    const transitioned = !full && data.rows.some(row => row._detail_full_required);
                    if (transitioned) {
                        let authoritative = client.rpc('read_auction_detail_static', { p_view: 'detail', p_id: request.id, p_search: '', p_status: 'active', p_sort: 'ending', p_page: 1 });
                        if (request.signal && authoritative.abortSignal) authoritative = authoritative.abortSignal(request.signal);
                        ({ data, error } = await authoritative);
                        if (error) throw error;
                        request.signal?.throwIfAborted();
                        if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || !Array.isArray(data.bids)) throw new Error('Invalid private auction detail.');
                    }
                    authoritativeRead = full || transitioned;
                    context = { data: full || transitioned ? data : { ...data, rows: data.rows.map(row => ({ ...context.data.rows.find(value => value.id === row.id), ...row })) },
                        at: Date.now(), staticAt: full || transitioned ? Date.now() : context.staticAt };
                    details.clear();
                    details.set(key, context);
                }
                // Unpublished drafts stay exclusively on the private transport.
                if (!livePromise && authoritativeRead || !context.data.rows.length || context.data.rows[0].status === 'pending_escrow') return context.data;
                // The full private read already supplies static fields. Only live
                // state needs the shared transport on subsequent polls.
                const result = livePromise ? await livePromise : { data: await this.load({ ...request, view: 'detail-live' }) };
                if (result.error) throw result.error;
                const live = result.data;
                const transitioned = live.rows.some(row => row.status !== context.data.rows.find(old => old.id === row.id)?.status);
                if (transitioned) { details.delete(key); return this.load(request); }
                return { ...context.data, server_time: live.server_time, public_snapshot: live.public_snapshot,
                    rows: context.data.rows.map(row => ({ ...row,
                        ...(Date.parse(live.public_snapshot?.captured_at) >= context.staticAt ? live.rows.find(value => value.id === row.id) : row),
                        ...(Number(live.rows.find(value => value.id === row.id)?.current_bid) !== Number(row.current_bid)
                            ? { highest_bidder_id: null, highest_bidder_username: null, viewer_is_highest_bidder: null } : {}),
                        _live_unavailable: live.public_snapshot?.live_unavailable === true })) };
            }

            const params = new URLSearchParams({ view: request.view });
            if (request.view === 'seller' || request.view.startsWith('detail-')) params.set('id', request.id);
            if (['browse', 'seller'].includes(request.view)) {
                for (const key of ['search', 'status', 'sort', 'trade', 'kind', 'buyout', 'bundle', 'page', 'minPrice', 'maxPrice']) {
                    if (request[key] != null) params.set(key, String(request[key]));
                }
            }
            const response = await fetcher(`/api/public-auctions?${params}`, {
                method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json', 'X-Khub-Live-State': '1' }, signal: request.signal,
            });
            if (!response.ok) {
                const retry = response.headers?.get('Retry-After');
                const retryAfterMs = retry == null ? 0 : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
                throw Object.assign(new Error('Public listings are temporarily busy. Please retry shortly.'), { status: response.status, retryAfterMs });
            }
            const data = await response.json();
            if (data?.shared_cache_version !== 1 || data?.privacy_version !== 1 || !Array.isArray(data.rows)
                || data.rows.length > (request.view === 'home' ? 120 : 24)) {
                throw Object.assign(new Error('The public auction snapshot could not be verified.'), { code: 'KHUB_PRIVACY' });
            }
            request.signal?.throwIfAborted();
            // Homepage cards show no names or personal actions. Pending trades
            // already have their own private read, so no extra database call is needed.
            if (request.view === 'home' || request.view.startsWith('detail-')) return data;
            const { data: auth, error: authError } = await client.auth.getSession();
            if (authError) throw authError;
            if (!auth.session && request.view !== 'seller') return data;
            // This response is never sent to the shared cache or persistent browser storage.
            const overlayKey = JSON.stringify([auth.session?.access_token || 'anon', request.view, request.id,
                data.rows.map(row => row.id).sort()]);
            let privateData;
            const saved = overlays.get(overlayKey);
            if (request.view === 'browse' && data.public_snapshot?.live_mode) privateData = await cardCache.load(auth.session?.access_token || 'anon', data.rows, { signal: request.signal });
            else {
                // Live polling must not multiply expensive per-viewer card reads.
                // Match the old listing read cadence; auth/ignore changes scope it.
                if (data.public_snapshot?.live_mode && saved && Date.now() - saved.at < (request.view === 'seller' ? 30000 : 60000)) privateData = saved.data;
                else {
                    let query = request.view === 'seller'
                        ? client.rpc('read_seller_auction_context', { p_seller_id: request.id, p_ids: auth.session ? data.rows.map(row => row.id) : [] })
                        : client.rpc('read_auction_card_context', { p_ids: data.rows.map(row => row.id) });
                    if (request.signal && query.abortSignal) query = query.abortSignal(request.signal);
                    const { data: result, error, status } = await query;
                    if (error) throw Object.assign(new Error(error.message || 'Your auction details could not be refreshed.'), { code: error.code, status });
                    request.signal?.throwIfAborted();
                    if (result?.privacy_version !== 1 || !Array.isArray(result.rows)) {
                        throw Object.assign(new Error('Your auction details could not be verified.'), { code: 'KHUB_PRIVACY' });
                    }
                    privateData = result;
                    overlays.set(overlayKey, { data: result, at: Date.now() });
                    while (overlays.size > 32) overlays.delete(overlays.keys().next().value);
                }
            }
            const byId = new Map(privateData.rows.map(row => [row.id, row]));
            const rows = auth.session ? data.rows.filter(row => byId.has(row.id)).map(row => ({ ...row, ...byId.get(row.id),
                ...(data.public_snapshot?.live_mode ? Object.fromEntries(LIVE_FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) : {}),
                ...(data.public_snapshot?.live_mode && Number(byId.get(row.id).current_bid) !== Number(row.current_bid)
                    ? { highest_bidder_id: null, highest_bidder_username: null, viewer_is_highest_bidder: null } : {}),
                _live_unavailable: row._live_unavailable === true,
            })) : data.rows;
            const ids = new Set(rows.map(row => row.id));
            return { ...data, rows, ...(request.view === 'seller' ? { seller: privateData.seller } : {}), server_time: privateData.server_time,
                ...(data.sections ? { sections: Object.fromEntries(Object.entries(data.sections).map(([key, values]) => [key, values.filter(id => ids.has(id))])) } : {}),
            };
        },
    };
}
