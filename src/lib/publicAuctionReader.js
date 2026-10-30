// Shared public snapshots and private viewer context use separate transports.
// Never send the browser's JWT/cookies or private query parameters to Cloudflare.
export function createPublicAuctionReader(client, { enabled = false, fetch: fetcher = globalThis.fetch } = {}) {
    const details = new Map();
    return {
        async accepts(request) {
            if (request.fresh && request.view === 'detail') details.clear();
            if (!enabled || !client || !['home', 'browse', 'seller', 'detail'].includes(request.view)
                || request.sellerId || request.excludeOwn || request.fresh || request.summaryOnly
                || ['seller', 'detail'].includes(request.view) && !request.id) return false;
            // Signed-in All can contain the viewer's unpublished drafts (or an
            // administrator's drafts). Keep that mixed public/private pool direct.
            if (['browse', 'seller'].includes(request.view) && request.status === 'all') {
                const { data, error } = await client.auth.getSession();
                if (error) throw error;
                if (data.session) return false;
            }
            return true;
        },
        async load(request) {
            if (request.view === 'detail') {
                const { data: auth, error: authError } = await client.auth.getSession();
                if (authError) throw authError;
                // Token scopes prevent reuse across sign-in, sign-out or authorization changes.
                const key = `${request.id}:${auth.session?.access_token || 'anon'}`;
                let context = details.get(key);
                if (!context || Date.now() - context.at >= 5000) {
                    const full = !context || Date.now() - context.staticAt >= 300000 || context.data.rows[0]?.status !== 'active' || context.data.rows[0]?.auction_kind === 'buy';
                    let query = client.rpc(full ? 'read_auction_page' : 'read_auction_detail_context', { p_view: 'detail', p_id: request.id,
                        p_search: '', p_status: 'active', p_sort: 'ending', p_page: 1 });
                    if (request.signal && query.abortSignal) query = query.abortSignal(request.signal);
                    let { data, error } = await query;
                    if (error) throw error;
                    request.signal?.throwIfAborted();
                    if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || !Array.isArray(data.bids)) throw new Error('Invalid private auction detail.');
                    const transitioned = !full && data.rows.some(row => row._detail_full_required);
                    if (transitioned) {
                        let authoritative = client.rpc('read_auction_page', { p_view: 'detail', p_id: request.id, p_search: '', p_status: 'active', p_sort: 'ending', p_page: 1 });
                        if (request.signal && authoritative.abortSignal) authoritative = authoritative.abortSignal(request.signal);
                        ({ data, error } = await authoritative);
                        if (error) throw error;
                        request.signal?.throwIfAborted();
                        if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || !Array.isArray(data.bids)) throw new Error('Invalid private auction detail.');
                    }
                    context = { data: full || transitioned ? data : { ...data, rows: data.rows.map(row => ({ ...context.data.rows.find(value => value.id === row.id), ...row })) },
                        at: Date.now(), staticAt: full || transitioned ? Date.now() : context.staticAt };
                    details.clear();
                    details.set(key, context);
                }
                // Unpublished drafts stay exclusively on the private transport.
                if (!context.data.rows.length || context.data.rows[0].status === 'pending_escrow') return context.data;
                const [staticData, live] = await Promise.all(['detail-static', 'detail-live'].map(view => this.load({ ...request, view })));
                return { ...context.data, server_time: live.server_time,
                    rows: context.data.rows.map(row => ({ ...row, ...staticData.rows.find(value => value.id === row.id),
                        ...(Date.parse(live.public_snapshot?.captured_at) >= context.staticAt ? live.rows.find(value => value.id === row.id) : row) })) };
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
                headers: { Accept: 'application/json' }, signal: request.signal,
            });
            if (!response.ok) throw Object.assign(new Error('Public listings are temporarily busy. Please retry shortly.'), { status: response.status });
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
            let query = request.view === 'seller'
                ? client.rpc('read_seller_auction_context', { p_seller_id: request.id, p_ids: auth.session ? data.rows.map(row => row.id) : [] })
                : client.rpc('read_auction_card_context', { p_ids: data.rows.map(row => row.id) });
            if (request.signal && query.abortSignal) query = query.abortSignal(request.signal);
            const { data: privateData, error, status } = await query;
            if (error) throw Object.assign(new Error(error.message || 'Your auction details could not be refreshed.'), { code: error.code, status });
            if (privateData?.privacy_version !== 1 || !Array.isArray(privateData.rows)) {
                throw Object.assign(new Error('Your auction details could not be verified.'), { code: 'KHUB_PRIVACY' });
            }
            const byId = new Map(privateData.rows.map(row => [row.id, row]));
            const rows = auth.session ? data.rows.filter(row => byId.has(row.id)).map(row => ({ ...row, ...byId.get(row.id) })) : data.rows;
            const ids = new Set(rows.map(row => row.id));
            return { ...data, rows, ...(request.view === 'seller' ? { seller: privateData.seller } : {}), server_time: privateData.server_time,
                ...(data.sections ? { sections: Object.fromEntries(Object.entries(data.sections).map(([key, values]) => [key, values.filter(id => ids.has(id))])) } : {}),
            };
        },
    };
}
