export const auctionStatusLabels = {
    active: 'Active',
    pending_escrow: 'Awaiting item deposit',
    settling: 'Sending escrow deliveries',
    awaiting_trade: 'Awaiting settlement',
    ended_no_bids: 'Ended without bids',
    cancelled: 'Cancelled',
    completed: 'Trade completed',
};

export function getAuctionStatus(auction, now = Date.now()) {
    if (auction.status && auction.status !== 'active') return auction.status;
    if (auction.endTime > now) return 'active';
    if (auction.escrowMode) return 'settling';
    return auction.highestBidderId || auction.currentBid > 0 ? 'awaiting_trade' : 'ended_no_bids';
}

export function getAuctionResult(auction, now = Date.now()) {
    const status = getAuctionStatus(auction, now);
    const hasWinner = ['awaiting_trade', 'completed', 'settling'].includes(status)
        && (auction.hasWinner ?? Boolean(auction.winnerId || auction.highestBidderId || auction.currentBid > 0));
    return {
        status,
        label: auctionStatusLabels[status],
        hasWinner,
        // Until the next server refresh finalizes a just-expired listing,
        // display its latest saved bid. Confirmations always recheck on server.
        winnerId: hasWinner ? auction.winnerId || auction.highestBidderId || null : null,
        winner: hasWinner ? auction.winner || auction.highestBidder : null,
        finalPrice: hasWinner ? auction.finalPrice ?? auction.currentBid : null,
    };
}
