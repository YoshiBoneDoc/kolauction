import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { feeLabel } from '../lib/feeDisplay';
import { escrowFee } from '../lib/escrowFees';

export default function EscrowProtection({ forListing = false, buy = false, showFees = true, feeBps = 500, feePolicy = 'tiered_v1', minimumPrice = null }) {
    if (buy) return <details className="text-left text-xs text-gray-600">
        <summary className="w-fit cursor-pointer">How Buy Auctions Work</summary>
        <div className="mt-2 space-y-2 leading-[1.4]">
            <p>Our bot, kHub (#3888760), securely holds your Meat and automatically purchases items as sellers fulfill your order.</p>
            <ul className="list-disc space-y-1 pl-4">
                <li><strong>Funded Offers:</strong> Deposit your Meat to activate your buy auction. The bot must accept your deposit within 24 hours of creating the listing.</li>
                <li><strong>Partial Fills:</strong> Sellers reserve a quantity on the website for 10 minutes, then send exactly those items with their reservation command. Your auction remains active until fully filled, canceled, or expired.</li>
                {showFees && <li><strong>Hardcore/Ronin Deliveries:</strong> Free gift packaging is used only while in Hardcore/Ronin, with items <Link to="/info#buy-gift-delivery" className="text-blue-700 underline">batched</Link> by price. Regular KMail delivery resumes once restrictions end.</li>}
                <li><strong>Flexible Delivery:</strong> Receive purchased items as they’re acquired or all at once when your order ends.</li>
                <li><strong>Cancel Anytime:</strong> Cancel your remaining order at any time. Unspent Meat is refunded; {showFees ? 'completed purchases and their fees are final.' : 'completed purchases are final.'}</li>
                <li><strong>Automatic Settlement:</strong> The bot handles payments, item deliveries, and refunds via KMail.</li>
                <li><strong>Fast Delivery:</strong> Transactions usually process within seconds. Service disruptions may cause delays.</li>
            </ul>
            {showFees && <p className="italic">Fees range from 1–5% depending on the item’s price. See the <Link to="/info#escrow-fees-title" className="text-blue-700 underline">fee chart</Link> for details. No purchase, no fee.</p>}
        </div>
    </details>;
    return <details className={forListing ? 'text-left text-xs text-gray-600' : 'group w-full text-left text-xs text-gray-600'}>
        {forListing ? <summary className="w-fit cursor-pointer rounded-md px-3 py-2 text-xs leading-snug text-green-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"><strong>Escrow protected</strong> · Full reimbursement for verified system errors</summary> : <summary className="cursor-pointer py-1 text-sm font-semibold text-[#334155] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">Escrow Protection — How It Works</summary>}
        <div className={forListing ? undefined : 'pt-2'}>
            <div className="mt-1 space-y-1 leading-[1.4]">
                <p>{forListing ? 'Our bot, kHub (#3888760), holds your items and bid Meat and handles the sale automatically.' : 'Our bot, kHub (#3888760), holds the items and bid Meat and handles the exchange automatically.'}</p>
                <ul className="list-disc space-y-0 pl-4">
                    <li><strong>Secure Item Storage:</strong> {forListing ? 'Once we confirm your items have been safely deposited, bidding opens and your auction timer starts. The bot must accept your deposit within 24 hours of creating the listing.' : 'Listed items must be held by the bot before bidding can begin.'}</li>
                    <li><strong>Funded Bids:</strong> Every accepted bid is backed by real Meat held while that bidder leads.</li>
                    <li><strong>Automatic Refunds:</strong> Outbid bidders receive their Meat back via KMail.</li>
                    <li><strong>Instant Settlement:</strong> {forListing ? 'When your auction ends, the bot sends the items to the winner and your payment to you via KMail.' : 'Items go to the winner and payment goes to the seller via KMail.'}</li>
                    <li><strong>Unsold Items:</strong> {forListing ? 'Your items are returned if no bids are accepted or you cancel before receiving a bid.' : 'Items are returned if no bids are accepted or the auction is canceled before receiving a bid.'}</li>
                    <li><strong>Fast Delivery:</strong> Refunds and deliveries usually arrive within seconds. Service disruptions may cause delays.</li>
                </ul>
                {forListing && <p className="italic">{feePolicy === 'flat' ? <>Successful sales are subject to a {feeBps / 100}% seller commission.</> : <>Fees start at 5% and decrease for higher-value sales, with each rate applying only to its portion of the final price. See the <Link to="/info#escrow-fees-title" className="text-blue-700 underline">fee chart</Link> for details.</>} The total fee is rounded down to whole Meat and automatically deducted from your proceeds. No sale, no fee.</p>}
                {forListing && feePolicy === 'tiered_v1' && Number.isSafeInteger(minimumPrice) && minimumPrice > 0 && <p>
                    At your minimum bid: estimated {feeLabel(escrowFee(minimumPrice), minimumPrice)}: {escrowFee(minimumPrice).toLocaleString('en-US')} Meat; seller proceeds {(minimumPrice - escrowFee(minimumPrice)).toLocaleString('en-US')} Meat. The actual fee uses the final sale price.
                </p>}
            </div>
            <p className={`${forListing ? 'mt-2' : 'mt-4'} rounded-[6px] border-l-[3px] border-[#22C55E] bg-[#F0FDF4] px-4 py-3 text-[#334155]`}>
                <strong className="font-bold text-[#15803D]">Escrow Protection Guarantee:</strong> In the unlikely event of a verified loss caused by an error in kHub’s automated escrow system, we guarantee full reimbursement without a cap. Losses resulting from malicious exploits, fraudulent activity, or circumstances outside kHub’s reasonable control are excluded.
            </p>
        </div>
    </details>;
}

EscrowProtection.propTypes = { forListing: PropTypes.bool, buy: PropTypes.bool, showFees: PropTypes.bool, feeBps: PropTypes.number, feePolicy: PropTypes.oneOf(['flat', 'tiered_v1']), minimumPrice: PropTypes.number };
