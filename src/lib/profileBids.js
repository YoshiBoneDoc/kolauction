const bidTime = bid => Number.isFinite(bid.timestamp) ? bid.timestamp : 0;
const snapshotTime = auction => (auction.bids || []).reduce((time, bid) => Math.max(time, bidTime(bid)), Math.max(
    Number.isFinite(auction.latestBidAt) ? auction.latestBidAt : 0,
    ...['completedAt', 'cancelledAt', 'finalizedAt'].map(key => Date.parse(auction[key]) || 0),
));

// Group by auction identity, never by item name. Preserve the underlying bids;
// one account-profile row displays the newest personal bid for that auction.
export function profileBidAuctions(auctions, userId) {
    const groups = new Map();
    for (const auction of auctions) {
        const time = snapshotTime(auction);
        const previous = groups.get(auction.id);
        if (!previous) {
            groups.set(auction.id, { auction, time, bids: [...(auction.bids || [])] });
            continue;
        }
        if (time > previous.time || time === previous.time && auction.currentBid >= previous.auction.currentBid) {
            previous.auction = auction;
            previous.time = time;
        }
        previous.bids.push(...(auction.bids || []));
    }
    return [...groups.values()].flatMap(({ auction, bids }) => {
        const unique = new Map();
        for (const bid of bids) {
            const key = bid.id || JSON.stringify([bid.bidderId, bid.timestamp, bid.amount]);
            const previous = unique.get(key);
            if (!previous || bidTime(bid) >= bidTime(previous)) unique.set(key, bid);
        }
        const merged = [...unique.values()];
        return merged.some(bid => bid.bidderId === userId) ? [{ ...auction, bids: merged }] : [];
    });
}

export function latestProfileBid(auction, userId) {
    return auction.bids.filter(bid => bid.bidderId === userId)
        .reduce((latest, bid) => !latest || bidTime(bid) > bidTime(latest)
            || bidTime(bid) === bidTime(latest) && bid.amount > latest.amount ? bid : latest, null);
}
