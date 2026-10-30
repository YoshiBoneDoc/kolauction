import { parsePrice } from './auctionPriceRange.js';
import { resolveAuctionSort } from './auctionBrowsing.js';
import { observeAuctionServerTime, auctionClockRequestStarted } from './auctionClock.js';
import { normalizeBundleTitle } from './bundles.js';
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
        auctionKind: row.auction_kind || 'sell',
        giveawayTitle: row.giveaway_title || null,
        isBundle: Array.isArray(row.bundle_items) && row.bundle_items.length > 1,
        bundleItems: Array.isArray(row.bundle_items) ? row.bundle_items.map(item => ({ ...item, id: Number(item.id), quantity: Number(item.quantity) })) : [],
        pricePerItem: Number(row.price_per_item || row.min_bid_meat),
        purchasedQuantity: Number(row.purchased_quantity || 0),
        remainingQuantity: Number(row.remaining_quantity ?? row.quantity),
        availableQuantity: Number(row.available_quantity ?? row.remaining_quantity ?? row.quantity),
        reservedQuantity: Number(row.reserved_quantity || 0),
        reducedQuantity: Number(row.reduced_quantity || 0),
        giftMeat: Number(row.gift_meat || 0),
        giftFundingNeeded: row.gift_funding_needed === true,
        buyClosingReason: row.buy_closing_reason || null,
        myReservation: row.my_reservation || null,
        reservationAudit: row.reservation_audit || [],
        deliveryMode: row.delivery_mode || 'immediate',
        fundingRequired: row.funding_required == null ? null : Number(row.funding_required),
        balanceMeat: row.balance_meat == null ? null : Number(row.balance_meat),
        heldQuantity: row.held_quantity == null ? null : Number(row.held_quantity),
        purchaseMeat: Number(row.purchase_meat || 0),
        buyCommissionMeat: Number(row.buy_commission_meat || 0),
        refundedMeat: Number(row.refunded_meat || 0),
        fulfillments: row.fulfillments || [],
        buyAdmin: row.buy_admin === true,
        fulfilledByMe: row.fulfilled_by_me === true,
        mySaleMeat: Number(row.my_sale_meat || 0),
        mySaleQuantity: row.my_sale_quantity == null ? null : Number(row.my_sale_quantity),
        auctionNumber: row.auction_number == null ? null : String(row.auction_number),
        sellerId: row.seller_id,
        owner: row.usernames_visible === false ? (row.auction_kind === 'buy' ? 'Buyer' : 'Seller') : row.seller_username,
        usernamesVisible: row.usernames_visible !== false,
        item: Array.isArray(row.bundle_items) && row.bundle_items.length > 1 && row.item && !row.item.startsWith('Bundle:') ? `Bundle: ${row.item}` : row.item,
        quantity: Number(row.quantity),
        minBidMeat: Number(row.min_bid_meat),
        itemId: row.item_id,
        marketValueMeat: Number(row.market_value_meat || 0),
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
        viewerIsHighestBidder: row.viewer_is_highest_bidder == null ? null : row.viewer_is_highest_bidder === true,
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
        closureReason: row.closure_reason || null,
        expiredAt: row.expired_at || null,
        bids,
        latestBidAt: row.latest_bid_at ? new Date(row.latest_bid_at).getTime() : null,
        bidCount: Number(row.bid_count ?? bids.length),
        isHot: row.is_hot === true,
    };
}

function databaseError(error) {
    let failure;
    if (['PGRST205', 'PGRST202', '42P01', '42883', '42501'].includes(error.code)) {
        failure = new Error('Auction storage is not ready. Apply any pending auction SQL migrations (including the auction page-read migration) in Supabase, then retry.');
    }
    return Object.assign(failure || new Error(error.message || 'The database request failed. Please try again.'), { code: error.code, status: error.status });
}

export function createAuctionService(client, { publicReader = null } = {}) {
    function requireClient() {
        if (!client) throw new Error('Auction storage is not configured yet.');
        return client;
    }

    return {
        async load({ view = 'browse', id = null, sellerId = null, excludeOwn = false, kind = 'all', buyout = 'any', bundle = 'any', summaryOnly = false, search = '', status = 'active', sort = resolveAuctionSort(status), trade = 'all', page = 1, minPrice = null, maxPrice = null, signal, fresh = false } = {}) {
            // Browsing is read-only. The existing bot tick expires all auction
            // types; write RPCs independently validate deadlines under their locks.
            const requestStartedAt = auctionClockRequestStarted();
            const sharedRequest = { view, id, sellerId, excludeOwn, kind, buyout, bundle, summaryOnly, search, status, sort, trade, page, minPrice, maxPrice, signal, fresh };
            let request;
            if (await publicReader?.accepts(sharedRequest)) request = publicReader.load(sharedRequest).then(data => ({ data }));
            else if (view === 'seller' && summaryOnly) request = requireClient().rpc('read_seller_auction_context', { p_seller_id: id, p_ids: [] });
            else if (view === 'home') request = requireClient().rpc('read_home_auctions');
            else request = requireClient().rpc(view === 'browse' ? 'read_filtered_auction_page' : 'read_auction_page', {
                p_view: view === 'browse' && excludeOwn ? 'others' : view === 'browse' && sellerId ? 'seller' : view,
                p_id: view === 'browse' && sellerId ? sellerId : id,
                p_search: search, p_status: status,
                ...(['browse', 'seller'].includes(view) && ['escrow', 'direct', 'none'].includes(trade) ? { p_trade: trade } : {}),
                ...(['buy', 'sell'].includes(kind) ? { p_kind: kind, p_trade: trade } : {}),
                ...(view === 'browse' && (buyout !== 'any' || bundle !== 'any') ? { p_buyout: buyout } : {}),
                ...(view === 'browse' && bundle !== 'any' ? { p_bundle: bundle } : {}),
                ...(view === 'browse' ? { p_trade: trade, p_kind: kind, p_min_price: minPrice, p_max_price: maxPrice } : {}),
                p_sort: sort, p_page: page,
            });
            if (signal && request.abortSignal) request.abortSignal(signal);
            const { data, error, status: statusCode } = await request;
            signal?.throwIfAborted();
            if (error) throw databaseError({ ...error, status: error.status ?? statusCode });
            if (data?.privacy_version !== 1) throw Object.assign(new Error('Auctions are temporarily unavailable while a privacy update is being completed. Please try again later.'), { code: 'KHUB_PRIVACY' });
            if (!Array.isArray(data.rows) || !Array.isArray(data.bids)
                || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0
                || (view === 'home' && (!data.sections || ['popular', 'new', 'ending', 'highRollers', 'recent'].some(key => !Array.isArray(data.sections[key]) || data.sections[key].length > 24)))
                || (view === 'home' ? data.rows.length > 120 : ['browse', 'seller'].includes(view) && data.rows.length > 24)) {
                throw new Error('The auction list could not be verified. Please retry shortly.');
            }
            observeAuctionServerTime(data.server_time, requestStartedAt);
            const auctions = data.rows.map(row => mapAuction(row, data.bids));
            let homeSections;
            if (view === 'home') {
                const byId = new Map(auctions.map(auction => [auction.id, auction]));
                homeSections = Object.fromEntries(Object.entries(data.sections).map(([key, ids]) => [key, ids.map(id => {
                    if (!byId.has(id)) throw new Error('The homepage auction list could not be verified.');
                    return byId.get(id);
                })]));
            }
            return { auctions, total: Number(data.total), seller: data.seller || null,
                ...(view === 'home' ? { siteTotals: data.site_totals || null } : {}),
                ...(data.public_snapshot ? { publicSnapshot: data.public_snapshot } : {}),
                ...(homeSections ? { homeSections } : {}),
                ...(view === 'browse' ? { priceBounds: data.price_bounds && parsePrice(data.price_bounds.min) != null && parsePrice(data.price_bounds.max) != null
                    ? { min: Number(data.price_bounds.min), max: Number(data.price_bounds.max) } : null } : {}),
            };
        },
        async pendingTrades(page = 1, { signal } = {}) {
            const request = requireClient().rpc('read_pending_trades', { p_page: page });
            if (signal && request.abortSignal) request.abortSignal(signal);
            const { data, error, status: statusCode } = await request;
            signal?.throwIfAborted();
            if (error) throw databaseError({ ...error, status: error.status ?? statusCode });
            if (data?.privacy_version !== 1) throw Object.assign(new Error('Private trade details are temporarily unavailable.'), { code: 'KHUB_PRIVACY' });
            return { auctions: data.rows.map((row) => mapAuction(row, [])), total: Number(data.total) };
        },
        async create(auction) {
            if (auction.bundleItems?.length) {
                const title = normalizeBundleTitle(auction.bundleTitle ?? '');
                const { data, error } = await requireClient().rpc('create_bundle_auction', {
                    p_items: auction.bundleItems.map(({ id, quantity }) => ({ id, quantity })),
                    p_min_bid_meat: auction.minBidMeat, p_duration_hours: Number(auction.auctionTime),
                    p_instant_purchase_price: auction.instantPurchasePrice ?? null, p_escrow_mode: auction.escrowMode !== false,
                    p_custom_end_at: auction.customEndAt || null,
                    ...(title ? { p_title: title } : {}),
                    ...(auction.bundleImageItemId ? { p_image_item_id: auction.bundleImageItemId } : {}),
                });
                if (error) throw databaseError(error);
                return data;
            }
            if (auction.auctionKind === 'buy') {
                const { data, error } = await requireClient().rpc('create_buy_auction', { p_item_id: auction.itemId, p_quantity: auction.quantity, p_price_per_item: auction.minBidMeat, p_duration_hours: Number(auction.auctionTime), p_delivery_mode: auction.deliveryMode });
                if (error) throw databaseError(error);
                return data;
            }
            const { data, error } = await requireClient().rpc(auction.giveawayTitle ? 'create_giveaway_auction' : 'create_auction', {
                ...(auction.giveawayTitle ? { p_title: auction.giveawayTitle } : {}),
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
        async reserveBuy(auctionId, quantity) {
            if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Enter a positive whole item quantity.');
            const { data, error } = await requireClient().rpc('reserve_buy_quantity', { p_auction_id: auctionId, p_quantity: quantity });
            if (error) throw databaseError(error);
            return data;
        },
        async cancelBuyReservation(reservationId) {
            const { data, error } = await requireClient().rpc('cancel_buy_reservation', { p_reservation_id: reservationId });
            if (error) throw databaseError(error);
            return data;
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
