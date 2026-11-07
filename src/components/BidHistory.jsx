import PropTypes from 'prop-types';
import useBidHistory from '../hooks/useBidHistory';

export default function BidHistory({ auction, currentUser, result }) {
    const { bids, error, loading, hasMore, loadOlder, refresh } = useBidHistory(auction);
    return (
            <section aria-label="Bid history" className="mx-auto mt-6 max-w-4xl rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
                <header className="mb-2 flex items-center justify-between gap-3 border-b border-gray-200 pb-4">
                    <h2 className="text-xl font-bold text-gray-800">Bid History</h2>
                    <span className="text-xs text-gray-500">{(auction.bidCount ?? bids.length).toLocaleString('en-US')} { (auction.bidCount ?? bids.length) === 1 ? 'bid' : 'bids'}</span>
                </header>
                {bids.length ? <ul className="divide-y divide-gray-200">
                    {bids.slice().reverse().map((bid, index) => (
                        <li key={bid.id || index} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3 text-sm">
                            <div className="min-w-0">
                                <span className="break-words font-medium text-gray-700">{bid.bidder}</span>
                                <p className="mt-1 text-xs text-gray-500">{new Date(bid.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                                {currentUser && bid.adminDeliveryReferences?.length > 0 && <ul aria-label="Administrator message references" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                                    {bid.adminDeliveryReferences.map(delivery => <li key={delivery.reference}>
                                        {delivery.label}: <span className="font-mono">{delivery.reference}</span> ({delivery.state})
                                    </li>)}
                                </ul>}
                            </div>
                            <div className="ml-auto text-right">
                                <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                                    <p className="font-medium text-gray-900">{bid.amount.toLocaleString('en-US')} Meat</p>
                                    {auction.instantPurchasedAt && bid.amount === auction.instantPurchasePrice && <p className="text-xs font-semibold text-green-700">Buyout</p>}
                                    {auction.giveawayTitle ? bid.giveawayWinner && result.hasWinner && <p className="giveaway-winner-label text-xs font-semibold text-green-700">Giveaway Winner</p>
                                        : !auction.instantPurchasedAt && result.hasWinner && bid.amount === result.finalPrice && <p className="text-xs font-semibold text-green-700">Winning bid</p>}
                                </div>
                                {auction.mrARate && <p className="mt-0.5 flex items-center justify-end gap-1 text-xs text-gray-500" aria-label="Bid payment">
                                    {(bid.paymentMrA || 0).toLocaleString('en-US')} x
                                    <img src="/art/mr-accessory.svg" alt="Mr. A" className="h-6 w-auto shrink-0" />
                                    <span>+ {(bid.paymentMeat ?? bid.amount).toLocaleString('en-US')} Meat</span>
                                </p>}
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
