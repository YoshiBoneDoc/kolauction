export const auctionStatusLabels = {
    active: 'Active',
    awaiting_trade: 'Awaiting trade',
    ended_no_bids: 'Ended without bids',
    cancelled: 'Cancelled',
    completed: 'Trade completed',
};

export function getAuctionStatus(auction, now = Date.now()) {
    if (auction.status && auction.status !== 'active') return auction.status;
    if (auction.endTime > now) return 'active';
    return auction.highestBidderId ? 'awaiting_trade' : 'ended_no_bids';
}

export function getAuctionResult(auction, now = Date.now()) {
    const status = getAuctionStatus(auction, now);
    const hasWinner = status === 'awaiting_trade' || status === 'completed';
    return {
        status,
        label: auctionStatusLabels[status],
        // Until the next server refresh finalizes a just-expired listing,
        // display its latest saved bid. Confirmations always recheck on server.
        winnerId: hasWinner ? auction.winnerId || auction.highestBidderId : null,
        winner: hasWinner ? auction.winner || auction.highestBidder : null,
        finalPrice: hasWinner ? auction.finalPrice ?? auction.currentBid : null,
    };
}
