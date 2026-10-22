// The database repeats these checks; a leading bid alone is not participation.
export function canSendTradeQuery(auction, user) {
    if (!auction || !user?.id || user.isBanned) return false;
    if (auction.auctionKind === 'buy') return auction.sellerId === user.id || auction.fulfilledByMe === true;
    const seller = auction.sellerId === user.id;
    const winner = Boolean(auction.finalizedAt && auction.winnerId === user.id);
    if (auction.escrowMode) return seller || winner;
    return Boolean((seller || winner) && auction.winnerId && auction.finalizedAt
        && ['awaiting_trade', 'completed'].includes(auction.status));
}
