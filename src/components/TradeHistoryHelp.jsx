export default function TradeHistoryHelp() {
    return <div className="mt-2 text-left leading-5">
        <p><strong>Completed:</strong> Trades confirmed by the other party, including those later resolved and completed.</p>
        <p><strong>Incomplete:</strong> Trades reported as unfulfilled because the seller or winning bidder failed to honor the trade. Marks count only once 48 hours have passed since the auction closed. <em>Incomplete reports may be disputed and dismissed after administrator review.</em></p>
        <p><strong>Feedback:</strong> Independent ratings based on the trading experience. Negative feedback doesn’t necessarily mean a trade was incomplete.</p>
    </div>;
}
