import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';

export default function SettlementTerms({ escrowMode, feeBps = 750, linkTips = true }) {
    return escrowMode ? <p>kHub holds the deposited items and accepted bid Meat, then handles settlement by KMail. Seller fee: {feeBps / 100}% of the final price, rounded down to whole Meat. No fee without a sale.</p>
        : <p>Direct settlement: trade with the other player after closing. kHub does not hold or verify the assets, enforce funding, or guarantee completion. Bids are promises to pay. No compulsory fee; {linkTips ? <Link to="/donate" className="text-blue-700 underline">tips are optional</Link> : 'tips are optional'} and never affect trade details, confirmations, feedback or reputation.</p>;
}

SettlementTerms.propTypes = { escrowMode: PropTypes.bool.isRequired, feeBps: PropTypes.number, linkTips: PropTypes.bool };
