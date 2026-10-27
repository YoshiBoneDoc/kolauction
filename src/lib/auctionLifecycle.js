export const auctionStatusLabels = {
    active: 'Active',
    expired: 'Expired',
    on_hold: 'On hold — admin review',
    bidding_closed: 'Bidding closed',
    voided: 'Cancelled by administrator',
    pending_escrow: 'Awaiting item deposit',
    finalizing: 'Finalizing bids…',
    settling: 'Sending escrow deliveries',
    awaiting_trade: 'Awaiting settlement',
    ended_no_bids: 'Ended without bids',
    cancelled: 'Cancelled',
    completed: 'Trade completed',
};

export function auctionCardBackground(status) {
    if (status === 'pending_escrow') return 'bg-[#FFF0CC]';
    if (status === 'completed') return 'bg-green-50';
    if (['cancelled', 'voided'].includes(status)) return 'bg-[#ECEDEF]';
    if (['awaiting_trade', 'settling'].includes(status)) return 'bg-yellow-50';
    if (['expired', 'ended_no_bids'].includes(status)) return 'bg-[#FFF0E5]';
    return 'bg-[#F8F6F4]';
}

export function getAuctionStatus(auction, now = Date.now()) {
    if (auction.status && auction.status !== 'active') return auction.status;
    if (auction.biddingRestricted && auction.endTime > now) return 'bidding_closed';
    if (auction.endTime > now) return 'active';
    // A local countdown cannot establish the outcome: an unseen bid may extend it.
    // Keep the last server status provisional until a fresh read confirms closure.
    return 'finalizing';
}

export function isUnclassifiedDepositClosure(auction) {
    return auction.status === 'cancelled' && auction.escrowMode && auction.itemEscrowedAt === null && !auction.closureReason;
}

export function getAuctionResult(auction, now = Date.now()) {
    const status = getAuctionStatus(auction, now);
    if (auction.auctionKind === 'buy') {
        const closing = auction.buyClosingReason && ['active', 'pending_escrow', 'settling'].includes(status);
        const label = closing ? { cancel: 'Closing — cancelled', deadline: 'Closing — expired', filled: 'Closing — fully filled' }[auction.buyClosingReason]
            : status === 'pending_escrow' ? 'Awaiting Meat deposit' : auctionStatusLabels[status];
        return { status, label, hasWinner: false, winnerId: null, winner: null, finalPrice: null };
    }
    const hasWinner = ['awaiting_trade', 'completed', 'settling'].includes(status)
        && (auction.hasWinner ?? Boolean(auction.winnerId || auction.highestBidderId || auction.currentBid > 0));
    return {
        status,
        label: isUnclassifiedDepositClosure(auction) ? 'Closed before deposit' : auctionStatusLabels[status],
        hasWinner,
        // Until the next server refresh finalizes a just-expired listing,
        // display its latest saved bid. Confirmations always recheck on server.
        winnerId: hasWinner ? auction.winnerId || auction.highestBidderId || null : null,
        winner: hasWinner ? auction.winner || auction.highestBidder : null,
        finalPrice: hasWinner ? auction.finalPrice ?? auction.currentBid : null,
    };
}

export function getAuctionDisplayStatus(auction, result = getAuctionResult(auction)) {
    const reportedIncomplete = !auction.escrowMode && result.status === 'awaiting_trade'
        && Boolean(auction.tradeReported || auction.sellerReportedIncomplete || auction.buyerReportedIncomplete);
    return {
        reportedIncomplete,
        label: reportedIncomplete ? 'Reported Incomplete' : result.label,
        color: reportedIncomplete ? 'text-[#DC2626]' : {
            awaiting_trade: 'text-[#476A91]',
            pending_escrow: 'text-[#476A91]',
            settling: 'text-[#476A91]',
            finalizing: 'text-[#476A91]',
            completed: 'text-[#15803D]',
            cancelled: 'text-[#64748B]',
        }[result.status] || 'text-[#64748B]',
    };
}
