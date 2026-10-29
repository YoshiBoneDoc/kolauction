// Shared cache schema: public catalogue/listing facts only. Never cache a raw RPC response.
import { parseSiteTradeTotals } from '../../src/lib/siteTradeTotals.js';
export const CACHE_VERSION = 1;
export const PUBLIC_FIELDS = [
    'id', 'auction_number', 'auction_kind', 'item', 'item_id', 'quantity', 'image',
    'min_bid_meat', 'current_bid', 'bid_count', 'duration_hours', 'created_at', 'end_time',
    'bid_deadline', 'status', 'escrow_mode', 'start_on_deposit', 'custom_end_at',
    'instant_purchase_price', 'instant_purchased_at', 'has_winner', 'final_price',
    'finalized_at', 'completed_at', 'cancelled_at', 'expired_at', 'closure_reason',
    'price_per_item', 'purchased_quantity', 'remaining_quantity', 'available_quantity',
    'reserved_quantity', 'reduced_quantity', 'delivery_mode', 'buy_closing_reason',
    'receipt_time_bidding', 'escrow_timing_review', 'finalization_not_before',
    'ban_review_required', 'bidding_restricted', 'market_value_meat', 'latest_bid_at', 'is_hot',
];
const statuses = ['active', 'completed', 'cancelled', 'expired', 'ended', 'all'];
const sorts = ['recommended', 'ending', 'ended-desc', 'newest', 'price-asc', 'price-desc', 'bids-desc', 'bids-asc', 'activity', 'high-rollers'];
const params = new Set(['view', 'id', 'search', 'status', 'sort', 'trade', 'kind', 'buyout', 'bundle', 'page', 'minPrice', 'maxPrice']);
const choose = (value, choices, fallback) => {
    if (value == null) return fallback;
    if (!choices.includes(value)) throw new Error('Unsupported public filter.');
    return value;
};

export function publicRequest(url) {
    const parsed = new URL(url);
    const query = parsed.searchParams;
    if (parsed.pathname === '/public-banner') {
        if (query.size) throw new Error('Banner does not accept filters.');
        return { view: 'banner' };
    }
    for (const key of query.keys()) {
        if (!params.has(key) || query.getAll(key).length !== 1) throw new Error('Unsupported public parameter.');
    }
    const view = choose(query.get('view'), ['home', 'browse', 'seller'], 'browse');
    if (view === 'home') {
        if (query.size !== 1) throw new Error('Homepage does not accept filters.');
        return { view };
    }
    let id;
    if (view === 'seller') {
        id = query.get('id');
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '')) throw new Error('Invalid public profile.');
        id = id.toLowerCase();
    } else if (query.has('id')) throw new Error('This view does not accept an ID.');
    const search = (query.get('search') || '').trim();
    if (search.length > 120 || [...search].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Search is too long or invalid.');
    const numeric = (key, fallback = null, max = Number.MAX_SAFE_INTEGER) => {
        if (!query.has(key)) return fallback;
        const raw = query.get(key);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new Error('Invalid public number.');
        return Number(raw);
    };
    const page = numeric('page', 1, 1000000);
    if (page < 1) throw new Error('Invalid page.');
    return { view, ...(id ? { id } : {}), search, status: choose(query.get('status'), statuses, view === 'seller' ? 'all' : 'active'),
        sort: choose(query.get('sort'), sorts, view === 'seller' ? 'ending' : 'recommended'),
        trade: choose(query.get('trade'), ['all', 'escrow', 'direct', 'none'], 'all'),
        kind: choose(query.get('kind'), ['all', 'sell', 'buy'], 'all'),
        buyout: choose(query.get('buyout'), ['any', 'with', 'without'], 'any'),
        bundle: choose(query.get('bundle'), ['any', 'with', 'without'], 'any'), page,
        minPrice: numeric('minPrice'), maxPrice: numeric('maxPrice') };
}

export function publicProjection(data, request) {
    if (request.view === 'banner') {
        if (data !== null && (!data || typeof data.revision !== 'string' || data.revision.length > 100
            || typeof data.message !== 'string' || data.message.length > 2000)) throw new Error('Invalid public banner.');
        return { privacy_version: 1, shared_cache_version: CACHE_VERSION,
            banner: data === null ? null : { revision: data.revision, message: data.message },
            server_time: new Date().toISOString() };
    }
    if (data?.privacy_version !== 1 || !Array.isArray(data.rows) || !Array.isArray(data.bids)
        || data.bids.length || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0
        || !Number.isFinite(Date.parse(data.server_time)) || data.rows.length > (request.view === 'home' ? 120 : 24)) {
        throw new Error('Invalid public snapshot.');
    }
    const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    const rows = data.rows.map(row => {
        if (!row || typeof row.id !== 'string' || row.status === 'pending_escrow') throw new Error('Nonpublic auction in snapshot.');
        return { ...pick(row, PUBLIC_FIELDS), usernames_visible: false,
            bundle_items: Array.isArray(row.bundle_items) ? row.bundle_items.map(item => pick(item, ['id', 'quantity', 'name', 'image'])) : [],
        };
    });
    const result = { privacy_version: 1, shared_cache_version: CACHE_VERSION,
        rows, total: Number(data.total), bids: [], seller: null, server_time: data.server_time };
    if (request.view === 'home') {
        const totals = parseSiteTradeTotals(data.site_totals);
        if (totals) result.site_totals = totals;
        const ids = new Set(rows.map(row => row.id));
        result.sections = Object.fromEntries(['popular', 'new', 'ending', 'highRollers', 'recent'].map(key => {
            const values = data.sections?.[key];
            if (!Array.isArray(values) || values.length > 24 || values.some(id => !ids.has(id))) throw new Error('Invalid public section.');
            return [key, values];
        }));
    } else if (data.price_bounds) result.price_bounds = pick(data.price_bounds, ['min', 'max']);
    return result;
}

export function originRequest(request) {
    if (request.view === 'banner') return { rpc: 'read_site_banner', args: {} };
    return request.view === 'home' ? { rpc: 'read_public_home_auctions', args: {} } : {
        rpc: 'read_public_auction_page', args: { p_view: request.view, p_id: request.id || null,
            p_search: request.search, p_status: request.status, p_sort: request.sort, p_page: request.page,
            ...(request.buyout && request.buyout !== 'any' || request.bundle && request.bundle !== 'any' ? { p_buyout: request.buyout || 'any' } : {}),
            ...(request.bundle && request.bundle !== 'any' ? { p_bundle: request.bundle } : {}),
            p_trade: request.trade, p_kind: request.kind, p_min_price: request.minPrice, p_max_price: request.maxPrice },
    };
}
