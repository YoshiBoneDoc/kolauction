import { useContext, useId, useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useLocation } from 'react-router-dom';
import AuctionBidForm from './AuctionBidForm';
import FittedPrice from './FittedPrice';
import InstantPurchaseAction from './InstantPurchaseAction';
import WinnerLink from './WinnerLink';
import { UserContext } from '../context/UserContext';
import { getAuctionDisplayStatus, getAuctionResult } from '../lib/auctionLifecycle';
import { formatCompactMeat } from '../lib/formatMeat';
import { auctionEndTime, timeRemaining } from '../lib/auctionBrowsing';

const itemCount = value => Number(value || 0).toLocaleString('en-US');

export default function PublicProfileAuctionCard({ auction, now }) {
    const { currentUser } = useContext(UserContext);
    const location = useLocation();
    const formId = useId();
    const [showBid, setShowBid] = useState(false);
    const linkState = { browseFrom: `${location.pathname}${location.search}` };
    const isBuy = auction.auctionKind === 'buy';
    const result = getAuctionResult(auction, now);
    const displayStatus = getAuctionDisplayStatus(auction, result);
    const active = result.status === 'active' && !auction.buyClosingReason;
    const itemLabel = `${auction.item} ×${itemCount(auction.quantity)}`;
    const buyPurchased = Number(auction.purchasedQuantity || 0);
    const buyTarget = Math.max(buyPurchased, Number(auction.quantity || 0) - Number(auction.reducedQuantity || 0));
    const buyRemaining = Math.max(0, buyTarget - buyPurchased);
    const endTimestamp = active ? auction.endTime : auctionEndTime(auction);
    const endDate = Number.isFinite(endTimestamp) ? new Date(endTimestamp) : null;
    const endLabel = active ? timeRemaining(auction.endTime, now).replace(/ \d+s$/, '')
        : endDate?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const statusClass = result.status === 'completed' ? 'is-completed'
        : ['cancelled', 'voided'].includes(result.status) ? 'is-cancelled'
            : ['expired', 'ended_no_bids'].includes(result.status) ? 'is-unsuccessful'
                : active ? 'is-active' : 'is-pending';
    const timeLeft = auction.endTime - now;
    const countdownClass = timeLeft < 3600000 ? 'is-urgent' : timeLeft <= 86400000 ? 'is-soon' : '';
    const currentUserCanBid = active && !isBuy && currentUser?.id !== auction.sellerId;
    const hasBid = Number(auction.currentBid) > 0;
    const hasBuyout = !isBuy && active && Number(auction.instantPurchasePrice) > 0;
    const secondaryPrice = isBuy
        ? <>{itemCount(buyPurchased)} / {itemCount(buyTarget)} filled</>
        : result.hasWinner
            ? <>Sold{result.winner && <> · Winner: <WinnerLink auction={auction} /></>}</>
            : active && hasBid
                ? <>Current bid{hasBuyout && <> · Buyout {formatCompactMeat(auction.instantPurchasePrice)}</>}</>
                : active
                    ? <>Min {formatCompactMeat(auction.minBidMeat)}{hasBuyout && <> · Buyout {formatCompactMeat(auction.instantPurchasePrice)}</>}</>
                    : ['cancelled', 'voided'].includes(result.status)
                        ? 'Cancelled'
                        : ['expired', 'ended_no_bids'].includes(result.status)
                            ? 'Ended without bids'
                            : hasBid ? 'Last bid' : displayStatus.label;

    return <article className={`public-profile-auction-row ${isBuy ? 'is-buy' : 'is-sell'}`}>
        <div className="public-profile-auction-row-main public-profile-auction-grid">
            <div className="profile-public-row-item">
                <div className="profile-public-row-identity">
                    {auction.image && <Link to={`/auction/${auction.id}`} state={linkState} aria-label={`View ${itemLabel}`} className="profile-public-row-image"><img src={auction.image} alt="" loading="lazy" /></Link>}
                    <span className="profile-public-row-item-text">
                        <span className="profile-public-row-title"><Link to={`/auction/${auction.id}`} state={linkState} title={itemLabel} className="profile-public-row-name">{auction.item}</Link> <span className="profile-public-row-quantity">×{itemCount(auction.quantity)}</span></span>
                        <span className="profile-public-row-number">
                            {auction.auctionNumber ? `#${auction.auctionNumber}` : 'Auction'} · {isBuy
                                ? <>{itemCount(buyPurchased)} / {itemCount(buyTarget)} filled{buyRemaining > 0 && <> · {itemCount(buyRemaining)} remaining</>}</>
                                : <>Min {formatCompactMeat(auction.minBidMeat)} Meat</>}
                        </span>
                    </span>
                </div>
            </div>

            <div className="profile-public-row-middle">
                <div className="profile-public-row-type">
                    <span className={`profile-auction-kind ${isBuy ? 'profile-auction-kind-buy' : 'profile-auction-kind-sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span>
                    <span className="profile-public-row-trade">· {isBuy || auction.escrowMode ? 'Escrow' : 'Direct'}</span>
                </div>
                <div className={`profile-public-row-status ${statusClass}`}>
                    <strong>{displayStatus.label}</strong>
                    {active ? <time className={countdownClass} dateTime={new Date(auction.endTime).toISOString()}>· {endLabel} left</time>
                        : endDate && <time dateTime={endDate.toISOString()} title={endDate.toLocaleString()}>· {endLabel}</time>}
                </div>
            </div>

            <div className="profile-public-row-price-area">
                <div className="profile-public-row-value">
                    {isBuy ? <strong>{formatCompactMeat(auction.pricePerItem)} Meat/item</strong>
                        : result.hasWinner || (active && hasBid) || (!active && hasBid)
                            ? <FittedPrice as="strong" fitKey={`${auction.id}:${result.finalPrice}:${auction.currentBid}`} title={`${(result.finalPrice ?? auction.currentBid).toLocaleString('en-US')} Meat`}>
                                {formatCompactMeat(result.finalPrice ?? auction.currentBid)} Meat
                            </FittedPrice>
                            : <strong className="profile-public-row-neutral">{active ? 'No bids yet' : 'No sale'}</strong>}
                    <span className="profile-public-row-label">{secondaryPrice}</span>
                </div>
                <div className="profile-public-row-actions">
                    {currentUserCanBid && <button type="button" aria-expanded={showBid} aria-controls={formId} onClick={() => setShowBid(value => !value)} className="profile-public-row-bid">{showBid ? 'Close' : 'Bid'}</button>}
                    {hasBuyout && <InstantPurchaseAction auction={auction} compact dense showPrice={false} />}
                </div>
            </div>
        </div>
        {showBid && currentUserCanBid && <div id={formId} className="profile-public-row-expanded"><AuctionBidForm auction={auction} /></div>}
    </article>;
}

PublicProfileAuctionCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired };
