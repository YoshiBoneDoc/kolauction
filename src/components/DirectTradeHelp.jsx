import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';

export default function DirectTradeHelp({ forListing = false }) {
    return <details className={forListing ? 'text-left text-xs text-gray-600' : 'group w-full text-left text-xs text-gray-600'}>
        <summary className={forListing ? 'w-fit cursor-pointer' : 'cursor-pointer py-1 text-sm font-semibold text-[#334155] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600'}>{forListing ? 'Direct Trade — Risks & Responsibilities' : 'Direct Trade — How It Works'}</summary>
        <div className={`mt-1 space-y-1 leading-[1.4] ${forListing ? '' : 'pt-2'}`}>
            <p>{forListing ? 'Trade directly with the winning bidder in-game once the auction concludes.' : 'Buyers and sellers trade directly in-game after the auction ends.'}</p>
            <ol className="list-decimal space-y-0 pl-4">
                <li><strong>Item Ownership:</strong> {forListing ? 'You must own the listed items throughout the auction and keep them in your Display Case for bidders to inspect.' : 'Sellers must own the items and display them in their Display Case throughout the auction.'}</li>
                <li><strong>Unfunded Bids:</strong> Bids are promises to pay. {forListing ? 'Meat is not collected or verified, so false bids and bidders backing out remain a possibility.' : 'Don’t bid with Meat you don’t have or aren’t prepared to spend.'}</li>
                <li><strong>Winner Details:</strong> {forListing ? 'The winning bidder’s username and player ID will be available on your auction page once it closes.' : 'Both parties receive each other’s username and player ID when the auction ends.'}</li>
                <li><strong>{forListing ? 'Honor the Trade:' : 'Trade Completion:'}</strong> {forListing ? 'If your auction ends with a valid bid, you are expected to complete the sale at the final price within 48 hours, unless both parties agree to an extension.' : 'Both parties are expected to honor their obligations and complete the exchange within 48 hours, unless both agree to an extension.'}</li>
                <li><strong>No Commission:</strong> Tips are entirely optional, but encouraged upon auction conclusion. Enjoyed our service? Let us know with a {forListing ? 'tip' : <Link to="/donate" className="text-blue-700 underline">tip</Link>}!</li>
            </ol>
            <p className="italic">Direct trades are conducted <strong>at your own risk</strong>. {forListing ? 'kHub does not hold items or Meat, guarantee payment or delivery, or reimburse losses from fraudulent bids or incomplete trades.' : 'kHub does not guarantee payment or delivery, nor reimburse losses from failed trades.'} For greater security, consider using escrow.</p>
        </div>
    </details>;
}
DirectTradeHelp.propTypes = { forListing: PropTypes.bool };
