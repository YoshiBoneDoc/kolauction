import { observeAuctionServerTime, auctionClockRequestStarted } from './auctionClock.js';
import { ESCROW_MIN_BID_LIMIT, ESCROW_MIN_BID_ERROR } from './escrowPolicy.js';
export function mapAuction(row, bidRows) {
    const bids = bidRows.filter((bid) => bid.auction_id === row.id)
        .sort((a, b) => Number(a.amount) - Number(b.amount))
        .map((bid) => ({
            id: bid.id,
            bidderId: bid.bidder_id,
            bidder: bid.bidder_username,
            amount: Number(bid.amount),
            timestamp: new Date(bid.created_at).getTime(),
            // The database omits this field unless the viewer is an administrator.
            adminDeliveryReferences: Array.isArray(bid.admin_delivery_references) ? bid.admin_delivery_references : [],
        }));
    const lastBid = bids.at(-1);
    const latestBid = lastBid?.amount >= Number(row.current_bid) ? lastBid : null;
    return {
        id: row.id,
        auctionNumber: row.auction_number == null ? null : String(row.auction_number),
        sellerId: row.seller_id,
        owner: row.usernames_visible === false ? 'Seller' : row.seller_username,
        usernamesVisible: row.usernames_visible !== false,
        item: row.item,
        quantity: Number(row.quantity),
        minBidMeat: Number(row.min_bid_meat),
        itemId: row.item_id,
        escrowMode: row.escrow_mode === true,
        startOnDeposit: row.start_on_deposit !== false,
        customEndAt: row.custom_end_at || null,
        itemEscrowedAt: row.item_escrowed_at,
        settledAt: row.settled_at,
        feeMeat: Number(row.fee_meat || 0),
        feeBps: Number(row.fee_bps || 0),
        feePolicy: row.fee_policy || 'flat',
        instantPurchasePrice: row.instant_purchase_price == null ? null : Number(row.instant_purchase_price),
        instantPurchasedAt: row.instant_purchased_at,
        auctionTime: row.duration_hours,
        image: row.image,
        createdAt: new Date(row.created_at).getTime(),
        endTime: new Date(row.bid_deadline || row.end_time).getTime(),
        receiptTimeBidding: row.receipt_time_bidding === true,
        escrowTimingReview: row.escrow_timing_review === true,
        finalizationNotBefore: row.finalization_not_before ? new Date(row.finalization_not_before).getTime() : null,
        currentBid: Math.max(Number(row.current_bid), lastBid?.amount || 0),
        highestBidderId: latestBid?.bidderId || row.highest_bidder_id,
        highestBidder: latestBid?.bidder || row.highest_bidder_username,
        status: row.status || 'active',
        banReviewRequired: row.ban_review_required === true,
        biddingRestricted: row.bidding_restricted === true,
        winnerId: row.winner_id,
        publicWinner: row.winner_public === true,
        winner: row.usernames_visible === false && row.has_winner ? 'Winner' : row.winner_username,
        hasWinner: row.has_winner,
        ownFeedback: row.own_feedback ?? null,
        ownTradeReportExcluded: row.own_trade_report_excluded === true,
        ownTradeReportWithdrawn: row.own_trade_report_withdrawn === true,
        ownTradeReport: row.own_trade_report || null,
        tradeReported: row.trade_reported === true,
        settlementContacts: row.usernames_visible === false ? null : row.settlement_contacts || null,
        finalPrice: row.final_price == null ? null : Number(row.final_price),
        finalizedAt: row.finalized_at,
        sellerConfirmedAt: row.seller_confirmed_at,
        buyerConfirmedAt: row.buyer_confirmed_at,
        sellerResolvedAt: row.seller_resolved_at,
        buyerResolvedAt: row.buyer_resolved_at,
        sellerReportExcluded: row.seller_report_excluded === true,
        buyerReportExcluded: row.buyer_report_excluded === true,
        sellerReportedIncomplete: row.seller_reported_incomplete ?? null,
        buyerReportedIncomplete: row.buyer_reported_incomplete ?? null,
        completedAt: row.completed_at,
        cancelledAt: row.cancelled_at,
        bids,
        latestBidAt: row.latest_bid_at ? new Date(row.latest_bid_at).getTime() : null,
        bidCount: Number(row.bid_count ?? bids.length),
        isHot: row.is_hot === true,
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
        async load({ view = 'browse', id = null, sellerId = null, excludeOwn = false, search = '', status = 'active', sort = 'ending', trade = 'all', page = 1 } = {}) {
            const { error } = await requireClient().rpc('finalize_expired_auctions');
            if (error) throw databaseError(error);
            async function readPage(pageNumber, completed = false) {
                // The historical home endpoint returns only four rows. Use the
                // existing privacy-filtered browse pages for the complete strip.
                const requestStartedAt = auctionClockRequestStarted();
                const { data, error: readError } = await requireClient().rpc('read_auction_page', {
                    p_view: view === 'home' ? 'browse' : view === 'browse' && excludeOwn ? 'others' : view === 'browse' && sellerId ? 'seller' : view,
                    p_id: view === 'browse' && sellerId ? sellerId : id,
                    p_search: view === 'home' ? '' : search, p_status: view === 'home' ? (completed ? 'completed' : 'active') : status,
                    ...(['browse', 'seller'].includes(view) && ['escrow', 'direct', 'none'].includes(trade) ? { p_trade: trade } : {}),
                    p_sort: view === 'home' ? (completed ? 'completed' : 'newest') : sort, p_page: pageNumber,
                });
                if (readError) throw databaseError(readError);
                if (data?.privacy_version !== 1) throw new Error('Auctions are temporarily unavailable while a privacy update is being completed. Please try again later.');
                observeAuctionServerTime(data.server_time, requestStartedAt);
                return data;
            }
            const data = await readPage(view === 'home' ? 1 : page);
            const rows = [...data.rows];
            const bids = [...data.bids];
            if (view === 'home') {
                // Bound the scan to the first response's page count. New listings
                // arriving mid-read are picked up by the next normal refresh.
                const pages = Math.ceil(Number(data.total) / 24);
                for (let next = 2; next <= pages; next++) {
                    const more = await readPage(next);
                    rows.push(...more.rows); bids.push(...more.bids);
                }
                const recent = await readPage(1, true);
                rows.push(...recent.rows); bids.push(...recent.bids);
            }
            const unique = [...new Map(rows.map(row => [row.id, row])).values()];
            return { auctions: unique.map(row => mapAuction(row, bids)), total: Number(data.total), seller: data.seller || null };
        },
        async pendingTrades(page = 1) {
            const { data, error } = await requireClient().rpc('read_pending_trades', { p_page: page });
            if (error) throw databaseError(error);
            if (data?.privacy_version !== 1) throw new Error('Private trade details are temporarily unavailable.');
            return { auctions: data.rows.map((row) => mapAuction(row, [])), total: Number(data.total) };
        },
        async create(auction) {
            if (auction.escrowMode !== false && Number(auction.minBidMeat) > ESCROW_MIN_BID_LIMIT) throw new Error(ESCROW_MIN_BID_ERROR);
            const { data, error } = await requireClient().rpc('create_auction', {
                p_item: auction.item,
                p_quantity: auction.quantity,
                p_min_bid_meat: auction.minBidMeat,
                p_duration_hours: Number(auction.auctionTime),
                p_image: auction.image || null,
                p_instant_purchase_price: auction.instantPurchasePrice ?? null,
                p_item_id: auction.itemId ?? null,
                p_escrow_mode: auction.escrowMode !== false,
                ...(auction.customEndAt ? { p_custom_end_at: auction.customEndAt } : {}),
            });
            if (error) throw databaseError(error);
            return data;
        },
        async confirmTrade(auctionId) {
            const { error } = await requireClient().rpc('confirm_auction_trade', { p_auction_id: auctionId });
            if (error) throw databaseError(error);
        },
        async rateTrade(auctionId, rating) {
            if (![1, -1].includes(rating)) throw new Error('Choose thumbs up or thumbs down.');
            const { error } = await requireClient().rpc('rate_trade_partner', { p_auction_id: auctionId, p_rating: rating });
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
            if (!Number.isSafeInteger(amount) || amount < 1) {
                throw new Error('Bid must be a positive whole Meat amount that can be represented exactly.');
            }
            const { error } = await requireClient().rpc('place_bid', { p_auction_id: auctionId, p_amount: amount });
            if (error) throw databaseError(error);
        },
    };
}
