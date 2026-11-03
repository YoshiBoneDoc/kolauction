import PropTypes from 'prop-types';
import { useNow } from '../hooks/useNow';
export default function ProfileTimeLeft({ endTime }) {
    const now = useNow();
    const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s left`;
}

ProfileTimeLeft.propTypes = { endTime: PropTypes.number.isRequired };
