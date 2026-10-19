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
        sellerId: row.seller_id,
        owner: row.seller_username,
        item: row.item,
        quantity: Number(row.quantity),
        minBidMeat: Number(row.min_bid_meat),
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
    };
}

function databaseError(error) {
    if (['PGRST205', 'PGRST202', '42P01', '42883', '42501'].includes(error.code)) {
        return new Error('Auction storage is not ready. Apply any pending auction SQL migrations (including the lifecycle migration) in Supabase, then retry.');
    }
    return new Error(error.message || 'The database request failed. Please try again.');
}

export function createAuctionService(client) {
    function requireClient() {
        if (!client) throw new Error('Auction storage is not configured yet.');
        return client;
    }

    async function readTable(table, columns) {
        const rows = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await requireClient().from(table).select(columns)
                .order('created_at', { ascending: true }).order('id', { ascending: true })
                .range(offset, offset + pageSize - 1);
            if (error) throw databaseError(error);
            rows.push(...data);
            if (data.length < pageSize) return rows;
        }
    }

    return {
        async load() {
            const { error } = await requireClient().rpc('finalize_expired_auctions');
            if (error) throw databaseError(error);
            // Read bids after listings, then use any newer bid in the display.
            const auctions = await readTable('auctions', '*');
            const bids = await readTable('bids', '*');
            return auctions.map((row) => mapAuction(row, bids))
                .sort((a, b) => b.createdAt - a.createdAt);
        },
        async create(auction) {
            const { data, error } = await requireClient().rpc('create_auction', {
                p_item: auction.item,
                p_quantity: auction.quantity,
                p_min_bid_meat: auction.minBidMeat,
                p_duration_hours: Number(auction.auctionTime),
                p_image: auction.image || null,
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
        async bid(auctionId, amount) {
            if (!Number.isSafeInteger(amount) || amount < 1 || amount > 20_000_000_000) {
                throw new Error('Bid must be a whole number between 1 and 20 billion Meat.');
            }
            const { error } = await requireClient().rpc('place_bid', { p_auction_id: auctionId, p_amount: amount });
            if (error) throw databaseError(error);
        },
    };
}
