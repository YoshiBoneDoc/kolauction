export function mapAuction(row, bidRows) {
    const bids = bidRows.filter((bid) => bid.auction_id === row.id)
        .sort((a, b) => Number(a.amount) - Number(b.amount))
        .map((bid) => ({
            id: bid.id,
            bidderId: bid.bidder_id,
            bidder: bid.bidder_username,
            amount: Number(bid.amount),
            timestamp: new Date(bid.created_at).getTime(),
        }));
    const lastBid = bids.at(-1);
    const latestBid = lastBid?.amount >= Number(row.current_bid) ? lastBid : null;
    return {
        id: row.id,
        auctionNumber: row.auction_number == null ? null : String(row.auction_number),
        sellerId: row.seller_id,
        owner: row.seller_username,
        item: row.item,
        quantity: Number(row.quantity),
        minBidMeat: Number(row.min_bid_meat),
        itemId: row.item_id,
        escrowMode: row.escrow_mode === true,
        startOnDeposit: row.start_on_deposit !== false,
        itemEscrowedAt: row.item_escrowed_at,
        settledAt: row.settled_at,
        feeMeat: Number(row.fee_meat || 0),
        feeBps: Number(row.fee_bps || 0),
        instantPurchasePrice: row.instant_purchase_price == null ? null : Number(row.instant_purchase_price),
        instantPurchasedAt: row.instant_purchased_at,
        auctionTime: row.duration_hours,
        image: row.image,
        createdAt: new Date(row.created_at).getTime(),
        endTime: new Date(row.end_time).getTime(),
        currentBid: Math.max(Number(row.current_bid), lastBid?.amount || 0),
        highestBidderId: latestBid?.bidderId || row.highest_bidder_id,
        highestBidder: latestBid?.bidder || row.highest_bidder_username,
        status: row.status || 'active',
        winnerId: row.winner_id,
        winner: row.winner_username,
        finalPrice: row.final_price == null ? null : Number(row.final_price),
        finalizedAt: row.finalized_at,
        sellerConfirmedAt: row.seller_confirmed_at,
        buyerConfirmedAt: row.buyer_confirmed_at,
        completedAt: row.completed_at,
        cancelledAt: row.cancelled_at,
        bids,
        bidCount: Number(row.bid_count ?? bids.length),
    };
}

function databaseError(error) {
    if (['PGRST205', 'PGRST202', '42P01', '42883', '42501'].includes(error.code)) {
        return new Error('Auction storage is not ready. Apply any pending auction SQL migrations (including the auction page-read migration) in Supabase, then retry.');
    }
    return new Error(error.message || 'The database request failed. Please try again.');
}

export function createAuctionService(client) {
    function requireClient() {
        if (!client) throw new Error('Auction storage is not configured yet.');
        return client;
    }

    return {
        async load({ view = 'browse', id = null, search = '', status = 'active', sort = 'ending', page = 1 } = {}) {
            const { error } = await requireClient().rpc('finalize_expired_auctions');
            if (error) throw databaseError(error);
            const { data, error: readError } = await requireClient().rpc('read_auction_page', {
                p_view: view, p_id: id, p_search: search, p_status: status, p_sort: sort, p_page: page,
            });
            if (readError) throw databaseError(readError);
            return { auctions: data.rows.map((row) => mapAuction(row, data.bids)), total: Number(data.total) };
        },
        async create(auction) {
            const { data, error } = await requireClient().rpc('create_auction', {
                p_item: auction.item,
                p_quantity: auction.quantity,
                p_min_bid_meat: auction.minBidMeat,
                p_duration_hours: Number(auction.auctionTime),
                p_image: auction.image || null,
                p_instant_purchase_price: auction.instantPurchasePrice ?? null,
                p_item_id: auction.itemId ?? null,
            });
            if (error) throw databaseError(error);
            return data;
        },
        async confirmTrade(auctionId) {
            const { error } = await requireClient().rpc('confirm_auction_trade', { p_auction_id: auctionId });
            if (error) throw databaseError(error);
        },
        async cancel(auctionId) {
            const { error } = await requireClient().rpc('cancel_auction', { p_auction_id: auctionId });
            if (error) throw databaseError(error);
        },
        async purchase(auctionId) {
            const { error } = await requireClient().rpc('purchase_auction', { p_auction_id: auctionId });
            if (error) throw databaseError(error);
        },
        async bid(auctionId, amount) {
            if (!Number.isSafeInteger(amount) || amount < 1 || amount > 20_000_000_000) {
                throw new Error('Bid must be a whole number between 1 and 20 billion Meat.');
            }
            const { error } = await requireClient().rpc('place_bid', { p_auction_id: auctionId, p_amount: amount });
            if (error) throw databaseError(error);
        },
    };
}
