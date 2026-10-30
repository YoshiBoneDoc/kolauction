import BundleContents from './BundleContents';
import { useContext } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import useKolIdentity from '../hooks/useKolIdentity';
import CopyMessage from './CopyMessage';
import { minimumAuctionBid } from '../lib/bidIncrements';

export default function KmailInstructions({ auction, mode = 'bid', showHeading = true }) {
    const { currentUser } = useContext(UserContext);
    const kolIdentity = useKolIdentity();
    const command = `${mode === 'list' ? 'LIST' : mode === 'buy' ? 'BUY' : 'BID'} ${auction.auctionNumber || auction.id}`;
    const minimum = mode === 'list' ? null : minimumAuctionBid(auction);
    return (
        <section aria-label={`${mode} KMail instructions`} className={`w-full space-y-2 rounded border border-gray-200 bg-white text-left text-sm leading-5 text-gray-800 ${mode === 'bid' ? 'bid-kmail-instructions p-4' : 'p-3'}`}>
            {auction.isBundle && mode !== 'list' && <BundleContents items={auction.bundleItems} />}
            {mode === 'bid' && showHeading && <h2 className="text-base font-semibold text-gray-900">Place a Bid</h2>}
            <p>Send a KMail to <strong>kHub (#3888760)</strong> with this exact message:</p>
            <CopyMessage text={command} label={`${command.split(' ')[0]} command`} className="text-base" compact={mode === 'bid'} />
            {mode === 'list' ? <>
                {auction.isBundle ? <><p>Attach every item below in one deposit, with the exact quantities and no Meat or extra items. Partial deposits are returned.</p><BundleContents items={auction.bundleItems} /></> : <p>Attach exactly <strong>{auction.quantity.toLocaleString('en-US')} × {auction.item}</strong>, with no Meat or extra items.</p>}
                <p>{auction.startOnDeposit ? `The ${auction.auctionTime}-hour timer starts when the bot accepts your deposit.` : `The deadline remains ${new Date(auction.endTime).toLocaleString()}.`}</p>
                <p className="text-xs text-gray-500">{auction.customEndAt ? 'The bot must accept your deposit before the chosen ending time and within 24 hours of creating this listing. Late deposits are returned.' : 'The bot must accept your deposit within 24 hours of creating this listing. Unfunded listings are removed after that deadline; late deposits are returned.'}</p>
            </> : mode === 'bid' ? <>
                <p>{minimum === null ? 'The maximum supported bid has been reached.' : <>Attach {auction.giveawayTitle ? 'exactly' : 'at least'} {auction.giveawayTitle ? <strong>{minimum.toLocaleString('en-US')} Meat</strong> : <>{minimum.toLocaleString('en-US')} Meat</>}, with no items. <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer" className="ml-2 inline-block whitespace-nowrap text-blue-700 underline">Open KoL KMail →</a></>}</p>
                <p className="text-xs leading-4 text-gray-500">{auction.receiptTimeBidding ? 'Outbid or rejected bids are automatically refunded.' : 'Bids are accepted only after the bot processes the KMail before the auction deadline. Outbid or rejected bids are automatically refunded.'}</p>
            </> : <>
                <p>Attach {mode === 'buy' ? <strong>exactly {auction.instantPurchasePrice.toLocaleString('en-US')} Meat</strong> : <>your <strong>full bid amount</strong>, at least {minimum.toLocaleString('en-US')} Meat</>}, with no items. This is a total for the entire listing.</p>
                <p>{auction.receiptTimeBidding ? 'Send your funded bid by KMail before the deadline.' : 'Your bid is accepted only after the bot processes the funded KMail before the deadline.'} Outbid or rejected funds are returned by KMail.</p>
                {mode === 'buy' && <p>Acceptance closes bidding. kHub then sends the items to you and payment to the seller.</p>}
            </>}
            {kolIdentity && !kolIdentity.kol_player_id && <p><Link to="/profile" className="text-blue-700 underline">Link your KoL account</Link> before sending. Matching a website username is not verification.</p>}
            {!currentUser && <p><Link to="/login" className="text-blue-700 underline">Log in</Link> to link your account.</p>}
            {mode !== 'bid' && <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center text-blue-700 underline">Open KoL KMail →</a>}
        </section>
    );
}
KmailInstructions.propTypes = { auction: PropTypes.object.isRequired, mode: PropTypes.oneOf(['list','bid','buy']), showHeading: PropTypes.bool };
