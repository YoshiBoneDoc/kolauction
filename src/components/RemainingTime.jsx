import PropTypes from 'prop-types';
import { useNow } from '../hooks/useNow';
import { timeRemaining } from '../lib/auctionBrowsing';

export default function RemainingTime({ endTime, hideSeconds = false }) {
    const now = useNow();
    const text = timeRemaining(endTime, now);
    return hideSeconds ? text.replace(/ \d+s$/, '') : text;
}
RemainingTime.propTypes = { endTime: PropTypes.number.isRequired, hideSeconds: PropTypes.bool };
