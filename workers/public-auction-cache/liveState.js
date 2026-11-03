// Cached catalogue facts may survive a live-state failure. Never return old prices,
// deadlines, availability or outcomes as though they were a current observation.
export const STATIC_FIELDS = ['id', 'auction_number', 'auction_kind', 'item', 'item_id', 'quantity', 'image',
    'duration_hours', 'created_at', 'escrow_mode', 'start_on_deposit', 'custom_end_at',
    'bundle_items', 'giveaway_title', 'giveaway_win_condition'];
export const LIVE_FIELDS = ['id', 'current_bid', 'bid_count', 'end_time', 'bid_deadline', 'status',
    'instant_purchase_price', 'instant_purchased_at', 'has_winner', 'final_price', 'finalized_at',
    'completed_at', 'cancelled_at', 'expired_at', 'closure_reason', 'price_per_item',
    'purchased_quantity', 'remaining_quantity', 'available_quantity', 'reserved_quantity',
    'reduced_quantity', 'delivery_mode', 'buy_closing_reason', 'receipt_time_bidding',
    'escrow_timing_review', 'finalization_not_before', 'ban_review_required', 'bidding_restricted'];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
export const unavailableRow = row => ({ ...pick(row, STATIC_FIELDS), usernames_visible: false, _live_unavailable: true });
export function overlayLive(data, live, { orderingDelayed = false, unavailable = false } = {}) {
    const byId = new Map(live?.rows.map(row => [row.id, row]) || []);
    return { ...data, server_time: live?.server_time || data.server_time,
        rows: data.rows.map(row => unavailable || !byId.has(row.id) ? unavailableRow(row)
            : { ...row, ...pick(byId.get(row.id), LIVE_FIELDS), _live_unavailable: false }),
        public_snapshot: { ...data.public_snapshot, ordering_delayed: orderingDelayed,
            live_unavailable: unavailable || data.rows.some(row => !byId.has(row.id)) } };
}
