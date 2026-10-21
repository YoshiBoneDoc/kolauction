import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { useContext } from 'react';
import { UserContext } from '../context/UserContext';

export default function WinnerLink({ auction }) {
    const { currentUser } = useContext(UserContext);
    if (!currentUser || currentUser.isBanned || auction.usernamesVisible === false) return <span>Winner</span>;
    const name = auction.winner || auction.highestBidder || 'Unknown winner';
    return auction.publicWinner && auction.winnerId
        ? <Link to={`/seller/${encodeURIComponent(auction.winnerId)}`} className="font-semibold text-blue-700 underline hover:text-blue-900">{name}</Link>
        : <span>{name}</span>;
}
WinnerLink.propTypes = { auction: PropTypes.object.isRequired };
