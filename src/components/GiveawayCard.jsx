import { giveawayConditionLabel } from '../lib/giveaway';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import TradeTypeBadge from './TradeTypeBadge';
import GiveawayItemImage from './GiveawayItemImage';
import FittedPrice from './FittedPrice';
import './giveaway.css';

const sprites = [[3,29,22,-14],[16,4,9,12],[20,69,9,-9],[77,4,8,12],[87,27,17,10],[77,63,12,-12],[67,79,6,15]];
const flames = [[2,5,14],[10,2,10],[23,22,7],[27,10,5],[22,49,6],[5,76,10],[13,65,7],[26,77,7],[72,24,9],[79,37,6],[85,8,7],[92,2,12],[92,73,11],[73,79,8],[84,67,5],[1,46,9],[11,82,6],[90,48,11],[97,63,7],[18,10,5]];
export function GiveawayDecorations({ source }) {
    return <div className="giveaway-decorations" aria-hidden="true">
        {flames.map(([x,y,size], i) => <span key={`f${i}`} className="giveaway-flame" style={{ left: `${x}%`, top: `${y}%`, '--size': `${size}cqh` }}>🔥</span>)}
        {sprites.map(([x,y,size,angle], i) => <GiveawayItemImage key={`s${i}`} source={source} className={`giveaway-sprite giveaway-sprite-${i}`} style={{ left: `${x}%`, top: `${y}%`, '--size': `${size}cqh`, '--angle': `${angle}deg` }} />)}
    </div>;
}
export function GiveawayCountdown({ endTime, now }) {
    const seconds = Math.max(0, Math.ceil((endTime - now) / 1000));
    return <span className="giveaway-countdown"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 3" /></svg><time dateTime={new Date(endTime).toISOString()}>{Math.floor(seconds / 3600)}h {Math.floor(seconds % 3600 / 60)}m {seconds % 60}s left</time></span>;
}
export default function GiveawayCard({ auction, now, compact = false }) {
    const bid = `${(auction.currentBid || auction.minBidMeat).toLocaleString('en-US')} Meat`;
    const title = auction.giveawayTitle;
    return <Link to={`/auction/${auction.id}`} aria-label={`${title}: ${auction.item}, ${auction.quantity.toLocaleString('en-US')} items`} className={`giveaway-card ${compact ? 'giveaway-card--compact h-[134px]' : 'giveaway-card--banner h-24'}`}>
        {compact ? <GiveawayDecorations source={auction.image} /> : <div className="giveaway-banner-background" aria-hidden="true">
            {[0, 1, 2].map(index => <div key={index} className="giveaway-banner-panel"><GiveawayDecorations source={auction.image} /></div>)}
        </div>}
        <div className="giveaway-content">
            <FittedPrice as="p" fitKey={`${auction.item}:${auction.quantity}`} className="giveaway-item-title">{auction.item} ×{auction.quantity.toLocaleString('en-US')}</FittedPrice>
            <div className={compact ? 'giveaway-title-slot' : 'giveaway-title-slot giveaway-title-splash'}>{compact
                ? <h2 className="giveaway-comic-title" data-title={title} style={{ '--title-scale': Math.max(.32, Math.min(1, 19 / title.length)) }}>{title}</h2>
                : <FittedPrice as="h2" fitKey={title} className="giveaway-comic-title">{title}</FittedPrice>}</div>
            <div className="giveaway-price-splash"><FittedPrice as="p" fitKey={bid} className="giveaway-price">{bid}</FittedPrice></div>
            <p className="text-xs">Win Condition: {giveawayConditionLabel(auction.giveawayWinCondition)}</p>
            <GiveawayCountdown endTime={auction.endTime} now={now} />
        </div>
        <span className="giveaway-badge"><TradeTypeBadge escrow={auction.escrowMode} compact short /></span>
    </Link>;
}
GiveawayCard.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number.isRequired, compact: PropTypes.bool };
GiveawayDecorations.propTypes = { source: PropTypes.string.isRequired };
GiveawayCountdown.propTypes = { endTime: PropTypes.number.isRequired, now: PropTypes.number.isRequired };
