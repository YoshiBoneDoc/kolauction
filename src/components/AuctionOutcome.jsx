import { paymentLabel } from '../lib/mrAPayment';
import PaymentAssets from './PaymentAssets';
import { effectiveFeePercent, feeLabel } from '../lib/feeDisplay';
import ConfirmTradeButton from './ConfirmTradeButton';
import TradeFeedback from './TradeFeedback';
import WithdrawTradeRating from './WithdrawTradeRating';
import WinnerLink from './WinnerLink';
import { useContext, useState } from "react";
import { Link } from 'react-router-dom';
import PropTypes from "prop-types";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import KmailInstructions from "./KmailInstructions";
import { getAuctionResult, isUnclassifiedDepositClosure } from "../lib/auctionLifecycle";
import { tradeResponseStatus, tradeResponseSummary } from '../lib/tradeResponses';
import TradeResponseBadge from './TradeResponseBadge';
import { canSendTradeQuery } from '../lib/tradeQueries';
import TradeReportDismissals from './TradeReportDismissals';

export default function AuctionOutcome({ auction, now }) {
    const { currentUser } = useContext(UserContext);
    const { cancelAuction } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const result = getAuctionResult(auction, now);
    const canViewPrivateTrade = Boolean(currentUser && !currentUser.isBanned && auction.usernamesVisible !== false);
    const isSeller = Boolean(canViewPrivateTrade && currentUser.id === auction.sellerId);
    const isWinner = Boolean(canViewPrivateTrade && result.winnerId && currentUser.id === result.winnerId);
    const partner = auction.settlementContacts && (isSeller ? auction.settlementContacts.buyer : auction.settlementContacts.seller);
    const hasConfirmed = isSeller ? auction.sellerConfirmedAt : auction.buyerConfirmedAt;
    const hasResolved = isSeller ? auction.sellerResolvedAt : auction.buyerResolvedAt;
    const bothCompleted = Boolean((auction.sellerConfirmedAt || auction.sellerResolvedAt) && (auction.buyerConfirmedAt || auction.buyerResolvedAt));
    const ownUnwithdrawnReport = Boolean(auction.ownTradeReport && !auction.ownTradeReportWithdrawn);
    const ownIncompleteReport = ownUnwithdrawnReport && !auction.ownTradeReportExcluded;
    const otherRole = isSeller ? 'buyer' : 'seller';
    const otherReportedIncomplete = auction[`${otherRole}ReportedIncomplete`] ?? Boolean(auction.tradeReported && !ownIncompleteReport);
    const responseSummary = tradeResponseSummary({
        confirmedComplete: Boolean(hasConfirmed || hasResolved), reportedIncomplete: ownIncompleteReport,
        resolvedIncomplete: Boolean(hasResolved), otherReportedIncomplete,
        reportExcluded: ownUnwithdrawnReport && auction.ownTradeReportExcluded,
        otherReportExcluded: auction[`${otherRole}ReportExcluded`],
        otherConfirmedComplete: Boolean(auction[`${otherRole}ConfirmedAt`] || auction[`${otherRole}ResolvedAt`]),
    });
    function responseStatus(role) {
        const ownRole = role === 'seller' ? isSeller : isWinner;
        const status = tradeResponseStatus({
            confirmedAt: auction[`${role}ConfirmedAt`], resolvedAt: auction[`${role}ResolvedAt`],
            reportExcluded: auction[`${role}ReportExcluded`],
            reportedIncomplete: Boolean(auction[`${role}ReportedIncomplete`] ?? (ownRole && ownIncompleteReport)),
        });
        const username = canViewPrivateTrade ? role === 'seller' ? auction.owner : result.winner : undefined;
        return <TradeResponseBadge status={status} role={role} username={username} />;
    }
    const canCancel = ['active','pending_escrow'].includes(result.status) && isSeller && !auction.highestBidderId && !auction.currentBid && !auction.bidCount;
    const escrowContact = auction.escrowMode && canSendTradeQuery(auction, currentUser)
        ? <Link to={`/auction/${auction.id}/trade-query`} className="inline-block text-sm text-blue-700 underline">Contact an Administrator</Link> : null;

    async function cancelListing() {
        if (pending || !window.confirm('Cancel this listing? It will remain in history and no longer accept bids.')) return;
        setPending(true);
        setError("");
        setMessage("");
        try {
            await cancelAuction(auction.id);
            setMessage('Cancellation saved.');
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }

    if (result.status === 'active') return isSeller ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm text-gray-600">{canCancel ? 'This is your listing. You may cancel before the first bid.' : 'This is your listing.'}</p>
        {canCancel && <button disabled={pending} onClick={cancelListing} className="button-red ml-auto min-h-9 rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-50">{pending ? 'Saving…' : 'Cancel this listing'}</button>}
        {escrowContact && <div className="w-full">{escrowContact}</div>}
        {message && <p role="status" className="w-full text-sm text-green-700">{message}</p>}
        {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
    </div> : null;

    if (result.status === 'on_hold' || result.status === 'voided') return <section aria-label="Auction review" className="mx-auto mt-6 max-w-4xl space-y-2 rounded-lg border border-gray-200 bg-white p-4 sm:p-6">
        <h2 className="text-xl font-bold text-slate-700">{result.label}</h2>
        <p className="text-sm text-gray-600">{result.status === 'on_hold'
            ? auction.escrowTimingReview ? 'This auction is on hold for administrator review.' : 'Bidding and automatic closing are paused while an administrator reviews an account restriction. No winner has been declared. Existing bids are preserved.'
            : 'An administrator cancelled this held auction. No winner or completed trade was recorded. Existing bids remain in its history.'}</p>
    </section>;

    if (auction.escrowMode && result.status === 'completed') return (
        <section aria-label="Auction escrow" className="mx-auto mt-6 max-w-4xl space-y-5 break-words rounded-2xl border border-gray-200 bg-white p-4 shadow sm:p-6">
            <header>
                <h2 className="flex items-center gap-2 text-2xl font-bold">
                    <svg aria-hidden="true" className="h-5 w-5 shrink-0 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
                    {result.label}
                </h2>
                <p className="mt-2 text-xs text-gray-500">Escrow trade · Completed via kHub bot</p>
            </header>
            {result.hasWinner && <dl className="space-y-4 border-t border-gray-200 pt-5 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-gray-500">Winner</dt><dd className="text-right"><WinnerLink auction={auction} /></dd></div>
                <div className="flex justify-between gap-4"><dt className="text-gray-500">Final price</dt><dd className="text-right">
                    <strong><PaymentAssets meat={auction.paymentMeat ?? result.finalPrice} mrA={auction.paymentMrA} /></strong>
                    {auction.mrARate && <p className="mt-3 text-xs text-gray-500">{result.finalPrice.toLocaleString('en-US')} Meat equivalent</p>}
                </dd></div>
            </dl>}
            {isSeller && result.hasWinner && <dl className="space-y-4 border-t border-gray-200 pt-5 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-gray-500">Commission ({effectiveFeePercent(auction.feeMeat, result.finalPrice)})</dt><dd className="text-right font-semibold">{(auction.feeMeat || 0).toLocaleString('en-US')} Meat</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-gray-500">Seller proceeds</dt><dd className="text-right font-semibold"><PaymentAssets meat={Math.max(0, (auction.paymentMeat ?? result.finalPrice) - (auction.feeMeat || 0))} mrA={auction.paymentMrA} /></dd></div>
                {auction.waivedFeeMeat > 0 && <div className="flex justify-between gap-4"><dt className="text-gray-500">Commission permanently waived</dt><dd className="text-right">{auction.waivedFeeMeat.toLocaleString('en-US')} Meat</dd></div>}
            </dl>}
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
                <p className="flex items-center gap-2"><svg aria-hidden="true" className="h-4 w-4 shrink-0 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5" /></svg>Payment and items delivered via KMail</p>
                {auction.instantPurchasedAt && <p className="mt-2 text-xs text-gray-500">Auction ended early through buyout.</p>}
            </div>
            {escrowContact && <div className="text-right">{escrowContact}</div>}
        </section>
    );

    if (auction.escrowMode) return (
        <section aria-label="Auction escrow" className="mx-auto mt-6 max-w-4xl space-y-4 break-words rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6">
            <h2 className="text-2xl font-bold">{result.label}</h2>
            <p>Handled by our bot, <strong>kHub (#3888760)</strong>.</p>
            {result.status === 'bidding_closed' && <p className="text-sm text-gray-600">New bids are closed following an account restriction. Existing funded bids and escrow deliveries remain protected; the bot will settle the auction at its deadline.</p>}
            {result.status === 'pending_escrow' && isSeller && <KmailInstructions auction={auction} mode="list" />}
            {result.status === 'settling' && <p>{result.hasWinner
                ? 'Bidding has closed. The bot is sending the items to the winner and payment to the seller via KMail. Settlement finishes once all required deliveries are confirmed.'
                : 'This auction did not result in a sale. The bot is returning the deposited items to the seller via KMail. The return finishes once all required deliveries are confirmed.'}</p>}
            {result.hasWinner && <p>Winner: <strong><WinnerLink auction={auction} /></strong> · Final price: <strong>{paymentLabel(auction.paymentMeat ?? result.finalPrice, auction.paymentMrA, result.finalPrice)}</strong></p>}
            {isSeller && result.hasWinner && <p>{feeLabel(auction.feeMeat, result.finalPrice, auction.feePolicy !== 'flat')}: {(auction.feeMeat || 0).toLocaleString('en-US')} Meat.</p>}
            {isSeller && auction.mrARate && result.hasWinner && <p>Seller proceeds: {paymentLabel(Math.max(0, auction.paymentMeat - auction.feeMeat), auction.paymentMrA)}. Commission permanently waived: {(auction.waivedFeeMeat || 0).toLocaleString('en-US')} Meat.</p>}
            {auction.instantPurchasedAt && <p>The buyout price ended bidding early.</p>}
            {result.status === 'completed' && <p>The items and payment have been delivered via KMail.</p>}
            {result.status === 'ended_no_bids' && <p>No bids were accepted. The bot has returned the items to the seller.</p>}
            {result.status === 'expired' && <p>The deposit deadline passed before kHub accepted the items. This listing expired automatically.</p>}
            {result.status === 'cancelled' && <p>{isUnclassifiedDepositClosure(auction)
                ? 'This listing closed before a deposit was accepted. It may have been canceled or reached its deposit deadline.'
                : 'This listing was cancelled. Any accepted item deposit has been returned.'}</p>}
            {(escrowContact || canCancel) && <div className="flex flex-wrap items-center justify-between gap-3">
                {escrowContact}
                {canCancel && <button disabled={pending} onClick={cancelListing} className="button-red ml-auto min-h-11 rounded border px-4 py-3 disabled:opacity-50">{pending ? 'Saving…' : 'Cancel listing'}</button>}
            </div>}
            {message && <p role="status" className="text-green-700">{message}</p>}
            {error && <p role="alert" className="text-red-700">{error}</p>}
        </section>
    );

    return (
        <section className="max-w-4xl mx-auto bg-white rounded-lg border border-gray-200 shadow p-4 sm:p-6 mt-6 break-words" aria-label="Auction outcome">
            <h2 className="text-2xl font-bold mb-3">{result.status === 'awaiting_trade' ? (isSeller || isWinner) ? 'Trade instructions' : 'Trade status:' : result.label}</h2>
            {auction.banReviewRequired && result.status === 'awaiting_trade' && <p className="mb-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">An account restriction affects this trade. An administrator can review evidence of completion. Do not send further assets without administrator guidance. Existing responses are preserved.</p>}
            {result.status === 'ended_no_bids' && <p>This auction ended without bids. There is no winner or trade to complete.</p>}
            {result.status === 'cancelled' && <p>{auction.closureReason === 'seller_cancelled' ? 'The seller cancelled this listing before any bids.' : 'This listing was cancelled before any bids.'} Its history is preserved.</p>}
            {['awaiting_trade', 'completed'].includes(result.status) && (
                <div className="mt-4 space-y-6">
                    {result.status === 'awaiting_trade' && !auction.banReviewRequired && (isSeller || isWinner) && (
                        <div className="space-y-6">
                            <div className="space-y-5">
                            <p><span className="text-sm">Your trading partner:</span> <strong>{partner?.kol_name || partner?.username || (isSeller ? result.winner : auction.owner)}{partner?.kol_player_id && ` (#${partner.kol_player_id})`}</strong></p>
                            <p>Arrange an {partner?.kol_player_id ? <a href={`https://www.kingdomofloathing.com/sendmessage.php?towho=${partner.kol_player_id}`} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">in-game trade</a> : 'in-game trade'}: send <strong>{isSeller ? `${auction.quantity.toLocaleString('en-US')} × ${auction.item}` : paymentLabel(auction.paymentMeat ?? result.finalPrice, auction.paymentMrA, result.finalPrice)}</strong> in exchange for <strong>{isSeller ? paymentLabel(auction.paymentMeat ?? result.finalPrice, auction.paymentMrA, result.finalPrice) : `${auction.quantity.toLocaleString('en-US')} × ${auction.item}`}</strong>. Check the item, quantity, price and player name/number before accepting.</p>
                            <div className="space-y-[10px] pt-3 text-sm leading-[1.4] text-[#5B6472]">
                                <p>Both parties are responsible for completing this <strong>direct trade</strong> and <strong>confirming its completion on kHub</strong>. While we can assist with issues, we cannot guarantee delivery or cover any losses.</p>
                                <p><strong>Failure to honor a trade is grounds for a temporary or permanent ban.</strong> We strictly enforce this policy to deter fraudulent listings, bids made in bad faith, and last-minute withdrawals.</p>
                            </div>
                            </div>
                            {!hasConfirmed && !hasResolved && !ownUnwithdrawnReport && <p>Confirm below only after you have received your side of the exchange.</p>}
                        </div>
                    )}
                    <div className={`space-y-2 ${result.status === 'awaiting_trade' && (isSeller || isWinner) ? 'pt-3' : ''}`}>
                        {(isSeller || isWinner || result.status === 'completed') && <h3 className="mb-2 font-bold text-black">Trade status:</h3>}
                        <p>{responseStatus('seller')}</p>
                        <p>{responseStatus('buyer')}</p>
                        <TradeReportDismissals auction={auction} />
                    </div>
                    {result.status === 'awaiting_trade' && (isSeller || isWinner) && (
                        ownUnwithdrawnReport
                            ? <div className="space-y-2">
                                <div className="space-y-0.5 text-sm text-gray-600">
                                    <p>{responseSummary}</p>
                                    <p>Reference: {auction.ownTradeReport}</p>
                                </div>
                                <TradeFeedback key={`${auction.id}:${currentUser.id}`} auctionId={auction.id} role={isSeller ? 'buyer' : 'seller'} rating={auction.ownFeedback} />
                                <div className="flex flex-col items-start gap-2 pt-4">
                                    <p className="whitespace-nowrap font-bold">Everything sorted out?</p>
                                    <WithdrawTradeRating auctionId={auction.id} />
                                </div>
                            </div>
                            : hasConfirmed || hasResolved
                            ? <div><p>{responseSummary}</p><TradeFeedback key={`${auction.id}:${currentUser.id}`} auctionId={auction.id} role={isSeller ? 'buyer' : 'seller'} rating={auction.ownFeedback} /></div>
                            : <div className="flex flex-wrap gap-3"><ConfirmTradeButton auctionId={auction.id} onConfirmed={() => setMessage('Your trade confirmation was saved.')} className="button-green min-h-11 w-full sm:w-auto rounded border border-green-700 bg-green-700 px-4 py-3 text-white disabled:opacity-50" />
                                {!auction.ownTradeReport && <Link to={`/auction/${auction.id}/report-trade`} className="button-red inline-flex min-h-11 items-center rounded border px-4 py-2">Report Incomplete</Link>}
                            </div>
                    )}
                    {result.status === 'completed' && <div>
                        <p>{auction.sellerResolvedAt || auction.buyerResolvedAt ? 'Both parties acknowledged completion of their in-game exchange' : 'Both parties confirmed their in-game exchange'}{auction.completedAt ? ` on ${new Date(auction.completedAt).toLocaleString()}` : ''}.</p>
                        {(isSeller || isWinner) && (hasConfirmed || hasResolved || auction.ownTradeReport) && <TradeFeedback key={`${auction.id}:${currentUser.id}`} auctionId={auction.id} role={isSeller ? 'buyer' : 'seller'} rating={auction.ownFeedback} />}
                    </div>}
                </div>
            )}
            {!bothCompleted && result.status !== 'completed' && (isSeller || isWinner) && auction.finalizedAt && ['awaiting_trade','completed'].includes(result.status) && <div className="mt-4 border-t border-gray-200 pt-4">
                <p className="mb-1 text-sm text-gray-600">Need to clarify something?</p>
                <Link to={`/auction/${auction.id}/trade-query`} className="inline-block text-sm text-blue-700 underline">Contact an Administrator</Link>
            </div>}
            {auction.ownTradeReportWithdrawn && (isSeller || isWinner) && (!hasResolved || result.status === 'completed') && <p className="mt-2 text-sm text-gray-600">{hasResolved ? 'Your incomplete report was withdrawn.' : 'Your earlier incomplete report was withdrawn.'}</p>}
            {canCancel && (
                <div className="mt-4">
                    <p>You can cancel this listing while it is active and has no bids.</p>
                    <button disabled={pending} onClick={cancelListing} className="button-red mt-2 min-h-11 w-full sm:w-auto border rounded px-4 py-3 disabled:opacity-50">{pending ? 'Saving…' : 'Cancel listing'}</button>
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
