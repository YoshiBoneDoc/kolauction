import PropTypes from 'prop-types';
import HomeRaffleCard from './HomeRaffleCard';
import useHomeRaffles from '../hooks/useHomeRaffles';
import StaticAuctionStrip from './StaticAuctionStrip';

export default function HighRollers({ auctions, now, children }) {
    const raffles = useHomeRaffles();
    return <StaticAuctionStrip leadingCards={raffles.length ? raffles.map(raffle => <li key={`raffle-${raffle.id}`} className="w-64 shrink-0"><HomeRaffleCard raffle={raffle} /></li>) : null} auctions={auctions} now={now} title="High Rollers" label="High Rollers" className={`mb-8 ${raffles.length ? 'high-rollers-with-raffles' : ''}`}>{raffles.length ? null : children}</StaticAuctionStrip>;
}
HighRollers.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node };
