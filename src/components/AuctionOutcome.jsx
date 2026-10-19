import { useContext, useState } from "react";
import PropTypes from "prop-types";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import KmailInstructions from "./KmailInstructions";
import { getAuctionResult } from "../lib/auctionLifecycle";

export default function AuctionOutcome({ auction, now }) {
    const { currentUser } = useContext(UserContext);
    const { confirmTrade, cancelAuction } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const result = getAuctionResult(auction, now);
    const isSeller = currentUser?.id === auction.sellerId;
    const isWinner = currentUser?.id === result.winnerId;
    const hasConfirmed = isSeller ? auction.sellerConfirmedAt : auction.buyerConfirmedAt;
    const canCancel = ['active','pending_escrow'].includes(result.status) && isSeller && !auction.highestBidderId;

    async function act(action) {
        if (pending) return;
        const prompt = action === 'cancel'
            ? 'Cancel this listing? It will remain in history and no longer accept bids.'
            : 'Confirm that you have finished the in-game exchange and received the agreed items or Meat? Only confirm after the exchange is complete.';
        if (!window.confirm(prompt)) return;
        setPending(true);
        setError("");
        setMessage("");
        try {
            if (action === 'cancel') {
                await cancelAuction(auction.id);
                setMessage('Cancellation saved.');
            } else {
                await confirmTrade(auction.id);
                setMessage('Your trade confirmation was saved.');
            }
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    if (auction.escrowMode) return (
        <section aria-label="Auction escrow" className="mx-auto mt-6 max-w-4xl space-y-4 break-words rounded-lg bg-white p-4 shadow sm:p-6">
            <h2 className="text-2xl font-bold">{result.label}</h2>
            <p>Escrow middleman: <strong>kHub (#3888760)</strong>.</p>
            {result.status === 'pending_escrow' && isSeller && <KmailInstructions auction={auction} mode="list" />}
            {result.status === 'active' && <p>The seller’s items are escrowed. Bids count only after kHub receives and accepts their attached Meat.</p>}
            {result.status === 'settling' && <p>Bidding is closed. kHub is sending the escrowed items and Meat by KMail. The record completes after the deliveries are acknowledged.</p>}
            {result.winnerId && <p>Winner: <strong>{result.winner}</strong> · Final price: <strong>{result.finalPrice.toLocaleString('en-US')} Meat</strong></p>}
            {auction.instantPurchasedAt && <p>The instant purchase price ended bidding early.</p>}
            {result.status === 'completed' && <p>kHub’s item delivery and payment were acknowledged. Seller fee: {auction.feeMeat.toLocaleString('en-US')} Meat.</p>}
            {result.status === 'ended_no_bids' && <p>No winning bid. The escrowed items have been returned to the seller.</p>}
            {result.status === 'cancelled' && <p>This listing was cancelled. Any accepted item deposit has been returned.</p>}
            {canCancel && <button disabled={pending} onClick={() => act('cancel')} className="min-h-11 rounded border border-red-600 bg-white px-4 py-3 text-red-700 disabled:opacity-50">{pending ? 'Saving…' : 'Cancel listing'}</button>}
            {message && <p role="status" className="text-green-700">{message}</p>}
            {error && <p role="alert" className="text-red-700">{error}</p>}
        </section>
    );

    return (
        <section className="max-w-4xl mx-auto bg-white rounded-lg shadow p-4 sm:p-6 mt-6 break-words" aria-label="Auction outcome">
            <h2 className="text-2xl font-bold mb-3">{result.label}</h2>
            {auction.instantPurchasedAt && <p className="mb-3 text-green-800">Instant purchase accepted for {auction.finalPrice.toLocaleString('en-US')} Meat on {new Date(auction.instantPurchasedAt).toLocaleString()}. Bidding ended early.</p>}
            {result.status === 'active' && <p>Bidding is open until {new Date(auction.endTime).toLocaleString()}.</p>}
            {result.status === 'ended_no_bids' && <p>This auction ended without bids. There is no winner or trade to complete.</p>}
            {result.status === 'cancelled' && <p>The seller cancelled this listing before any bids. Its history is preserved.</p>}
            {result.winnerId && (
                <>
                    <p>Winning bidder: <strong>{result.winner}</strong></p>
                    <p>Final price: <strong>{result.finalPrice.toLocaleString('en-US')} Meat</strong></p>
                    <p>Seller: <strong>{auction.owner}</strong></p>
                </>
            )}
            {result.status === 'awaiting_trade' && (
                <div className="mt-4 space-y-3">
                    <p>The winning bid has been recorded. The in-game exchange is still pending.</p>
                    {(isSeller || isWinner) && (
                        <>
                            <p>Arrange an exchange in KoL of <strong>{auction.quantity.toLocaleString('en-US')} × {auction.item}</strong> for <strong>{result.finalPrice.toLocaleString('en-US')} Meat</strong> with {isSeller ? result.winner : auction.owner}. Confirm the other party&apos;s KoL identity before trading.</p>
                            <p>Use auction reference <span className="font-mono break-all">{auction.id}</span> in your kMail or trade discussion.</p>
                            <p>This site records your confirmations; it does not transfer items or Meat. Confirm below only after you have received your side of the exchange.</p>
                        </>
                    )}
                    <p>Seller: {auction.sellerConfirmedAt ? 'confirmed' : 'not yet confirmed'} · Buyer: {auction.buyerConfirmedAt ? 'confirmed' : 'not yet confirmed'}</p>
                    {(isSeller || isWinner) && (
                        hasConfirmed
                            ? <p>Your confirmation is saved. Waiting for the other party.</p>
                            : <button disabled={pending} onClick={() => act('confirm')} className="min-h-11 w-full sm:w-auto bg-blue-600 text-white rounded px-4 py-3 disabled:opacity-50">{pending ? 'Saving…' : 'Confirm my trade is complete'}</button>
                    )}
                </div>
            )}
            {result.status === 'completed' && <p className="mt-3">Both parties confirmed their in-game exchange{auction.completedAt ? ` on ${new Date(auction.completedAt).toLocaleString()}` : ''}.</p>}
            {canCancel && (
                <div className="mt-4">
                    <p>You can cancel this listing while it is active and has no bids.</p>
                    <button disabled={pending} onClick={() => act('cancel')} className="mt-2 min-h-11 w-full sm:w-auto border border-red-600 text-red-700 rounded px-4 py-3 disabled:opacity-50">{pending ? 'Saving…' : 'Cancel listing'}</button>
                </div>
            )}
            {message && <p role="status" className="text-green-700 mt-3">{message}</p>}
            {error && <p role="alert" className="text-red-700 mt-3">{error}</p>}
        </section>
    );
}

AuctionOutcome.propTypes = {
    auction: PropTypes.object.isRequired,
    now: PropTypes.number.isRequired,
};
