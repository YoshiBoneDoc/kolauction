import { useContext } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import useKolIdentity from '../hooks/useKolIdentity';
import CopyMessage from './CopyMessage';

export default function KmailInstructions({ auction, mode = 'bid' }) {
    const { currentUser } = useContext(UserContext);
    const kolIdentity = useKolIdentity();
    const command = `${mode === 'list' ? 'LIST' : mode === 'buy' ? 'BUY' : 'BID'} ${auction.auctionNumber || auction.id}`;
    const minimum = Math.max(auction.minBidMeat, (auction.currentBid || 0) + 1);
    return (
        <section aria-label={`${mode} KMail instructions`} className="w-full space-y-3 rounded border bg-white p-3 text-left text-sm text-gray-800">
            <p>Send KMail to <strong>kHub (#3888760)</strong> with this exact message:</p>
            <CopyMessage text={command} label={`${command.split(' ')[0]} command`} className="text-base" />
            {mode === 'list' ? <>
                <p>Attach exactly <strong>{auction.quantity.toLocaleString('en-US')} × {auction.item}</strong>, with no Meat or extra items.</p>
                <p>{auction.startOnDeposit ? `The ${auction.auctionTime}-hour timer starts when the bot accepts your deposit.` : `The deadline remains ${new Date(auction.endTime).toLocaleString()}.`}</p>
            </> : <>
                <p>Attach {mode === 'buy' ? <strong>exactly {auction.instantPurchasePrice.toLocaleString('en-US')} Meat</strong> : <>your <strong>full bid amount</strong>, at least {minimum.toLocaleString('en-US')} Meat</>}, with no items. This is a total for the entire listing.</p>
                <p>Your bid is accepted only after the bot processes the funded KMail before the deadline. Outbid or rejected funds are returned by KMail.</p>
                {mode === 'buy' && <p>Acceptance closes bidding. kHub then sends the items to you and payment to the seller.</p>}
            </>}
            {kolIdentity && !kolIdentity.kol_player_id && <p><Link to="/profile" className="text-blue-700 underline">Link your KoL account</Link> before sending. Matching a website username is not verification.</p>}
            {!currentUser && <p><Link to="/login" className="text-blue-700 underline">Log in</Link> to link your account.</p>}
            <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-blue-700 underline">Open KoL KMail</a>
        </section>
    );
}
KmailInstructions.propTypes = { auction: PropTypes.object.isRequired, mode: PropTypes.oneOf(['list','bid','buy']) };
