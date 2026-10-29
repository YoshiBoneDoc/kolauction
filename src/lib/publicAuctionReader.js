// Shared public snapshots and private viewer context use separate transports.
// Never send the browser's JWT/cookies or private query parameters to Cloudflare.
export function createPublicAuctionReader(client, { enabled = false, fetch: fetcher = globalThis.fetch } = {}) {
    return {
        async accepts(request) {
            if (!enabled || !client || !['home', 'browse', 'seller'].includes(request.view)
                || request.sellerId || request.excludeOwn || request.fresh || request.summaryOnly
                || request.view === 'seller' && !request.id) return false;
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
            const params = new URLSearchParams({ view: request.view });
            if (request.view === 'seller') params.set('id', request.id);
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
            if (request.view === 'home') return data;
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
