import PropTypes from 'prop-types';
import TradeTypeBadge from './TradeTypeBadge';
import { itemImageUrl } from '../lib/itemCatalog';
import { raffleCountdown } from '../lib/raffles';
import './raffles.css';
export default function RaffleSummary({ raffle, now = Date.now() }) {
    return <article className="raffle-summary"><div className="raffle-badges"><span className="raffle-label">Raffle</span><TradeTypeBadge escrow /><span>{raffle.state && raffle.state !== 'preview' ? raffle.state : 'Preview'}</span></div><h2>{raffle.name}{raffle.raffle_number && ` #${raffle.raffle_number}`}</h2><div className="raffle-facts"><strong>{Number(raffle.ticket_price).toLocaleString('en-US')} Meat <small>/ ticket</small></strong><span>{Date.parse(raffle.ends_at) <= now && ['active', 'drawing'].includes(raffle.state) ? 'Finalizing tickets…' : raffleCountdown(raffle.ends_at, now)}</span></div><p>Possible prizes</p><ul className="raffle-prizes">{raffle.prizes.map(p => <li key={p.id ?? p.item_id}>{itemImageUrl(p.image) && <img src={itemImageUrl(p.image)} alt="" />}<span>{p.name}<small>Quantity: {Number(p.quantity).toLocaleString('en-US')} · Win chance: {(p.probability_bps / 100).toFixed(2)}%</small></span></li>)}</ul><p>Closes {new Date(raffle.ends_at).toLocaleString()}</p></article>;
}
RaffleSummary.propTypes = { raffle: PropTypes.object.isRequired, now: PropTypes.number };
