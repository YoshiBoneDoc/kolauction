import PropTypes from 'prop-types';
import useBidHistory from '../hooks/useBidHistory';

export default function BidHistory({ auction, currentUser, result }) {
    const { bids, error, loading, hasMore, loadOlder, refresh } = useBidHistory(auction);
    return (
            <section aria-label="Bid history" className="mx-auto mt-6 max-w-4xl rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
                <h2 className="mb-4 text-2xl font-bold text-gray-800">Bid History</h2>
                {bids.length ? <ul className="divide-y divide-gray-200">
                    {bids.slice().reverse().map((bid, index) => (
                        <li key={bid.id || index} className="flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                            <div className="min-w-0">
                                <span className="break-words font-medium text-gray-700">{bid.bidder}</span>
                                {currentUser && bid.adminDeliveryReferences?.length > 0 && <ul aria-label="Administrator message references" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                                    {bid.adminDeliveryReferences.map(delivery => <li key={delivery.reference}>
                                        {delivery.label}: <span className="font-mono">{delivery.reference}</span> ({delivery.state})
                                    </li>)}
                                </ul>}
                            </div>
                            <div className="sm:text-right">
                                <p className="font-bold text-gray-900">{bid.amount.toLocaleString('en-US')} Meat</p>
                                {auction.instantPurchasedAt && bid.amount === auction.instantPurchasePrice && <p className="text-xs font-semibold text-green-700">Buyout</p>}
                                {auction.giveawayTitle ? bid.giveawayWinner && result.hasWinner && <p className="giveaway-winner-label text-xs font-semibold text-green-700">Giveaway Winner</p>
                                    : !auction.instantPurchasedAt && result.hasWinner && bid.amount === result.finalPrice && <p className="text-xs font-semibold text-green-700">Winning bid</p>}
                                <p className="text-xs text-gray-600">{new Date(bid.timestamp).toLocaleString()}</p>
                            </div>
                        </li>
                    ))}
                </ul> : !loading && !error && <p className="text-gray-600">No bids yet.</p>}
                {error && <p role="status" className="text-sm text-red-700">History refresh delayed. <button className="underline" onClick={refresh}>Retry</button></p>}
                {loading && <p role="status" className="text-sm">Loading bid history…</p>}
                {hasMore && <button disabled={loading} onClick={loadOlder} className="mt-3 text-sm text-blue-700 underline disabled:opacity-50">Load older bids</button>}
            </section>
    );
}
BidHistory.propTypes = { auction: PropTypes.object.isRequired, currentUser: PropTypes.object, result: PropTypes.object.isRequired };
