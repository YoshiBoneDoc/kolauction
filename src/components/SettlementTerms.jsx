import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';

export default function SettlementTerms({ escrowMode, feeBps = 500, feePolicy = 'tiered_v1', linkTips = true }) {
    return escrowMode ? <p>Our bot, kHub (#3888760), holds your items before bidding begins and accepts Meat-backed bids. After a sale, the bot sends the items to the winner and payment to the seller via KMail. Unsold or canceled listings have their deposited items returned. {feePolicy === 'flat' ? <>Seller commission: {feeBps / 100}% of the final price, deducted from your proceeds and rounded down to whole Meat.</> : <>Seller commission starts at 5% and decreases for higher-value sales. Each rate applies only to its portion of the final price; the total fee is rounded down to whole Meat and deducted from your proceeds. See the <Link to="/info#escrow-fees-title" className="text-blue-700 underline">fee chart</Link> for details.</>} No sale, no fee.</p>
        : <p>Direct settlement: trade with the other player after closing. kHub does not hold or verify the assets, enforce funding, or guarantee completion. Bids are promises to pay. No compulsory fee; {linkTips ? <Link to="/donate" className="text-blue-700 underline">tips are optional</Link> : 'tips are optional'} and never affect trade details, trade responses or reputation.</p>;
}

SettlementTerms.propTypes = { escrowMode: PropTypes.bool.isRequired, feeBps: PropTypes.number, feePolicy: PropTypes.oneOf(['flat', 'tiered_v1']), linkTips: PropTypes.bool };
