import PropTypes from 'prop-types';
import { useNow } from '../hooks/useNow';
import { timeRemaining } from '../lib/auctionBrowsing';

export default function RaffleCardTime({ endTime, prefix = '', suffix = '' }) {
    const now = useNow();
    return <span className={endTime > now && endTime - now < 3600000 ? 'raffle-card-urgent' : undefined}>{prefix}{timeRemaining(endTime, now)}{suffix}</span>;
}
RaffleCardTime.propTypes = { endTime: PropTypes.number.isRequired, prefix: PropTypes.string, suffix: PropTypes.string };
