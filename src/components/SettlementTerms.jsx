import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';

export default function SettlementTerms({ escrowMode, feeBps = 750, linkTips = true }) {
    return escrowMode ? <p>Our bot, kHub (#3888760), holds your items before bidding begins, accepts Meat-backed bids, and automatically sends the items and payment via KMail when the auction ends. Seller commission: {feeBps / 100}% of the final price, deducted from your proceeds and rounded down to whole Meat. No sale, no fee.</p>
        : <p>Direct settlement: trade with the other player after closing. kHub does not hold or verify the assets, enforce funding, or guarantee completion. Bids are promises to pay. No compulsory fee; {linkTips ? <Link to="/donate" className="text-blue-700 underline">tips are optional</Link> : 'tips are optional'} and never affect trade details, trade responses or reputation.</p>;
}

SettlementTerms.propTypes = { escrowMode: PropTypes.bool.isRequired, feeBps: PropTypes.number, linkTips: PropTypes.bool };
