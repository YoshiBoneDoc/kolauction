import PropTypes from 'prop-types';
import { useContext } from 'react';
import { UserContext } from '../context/UserContext';
import { Link } from 'react-router-dom';

export default function SellerLink({ auction }) {
    const { currentUser } = useContext(UserContext);
    const role = auction.auctionKind === 'buy' ? 'Buyer' : 'Seller';
    const name = currentUser && !currentUser.isBanned && auction.usernamesVisible !== false ? auction.owner || role : role;
    return auction.sellerId ? <Link to={`/seller/${encodeURIComponent(auction.sellerId)}`} className="font-semibold text-blue-700 underline hover:text-blue-900">{name}</Link> : <span>{name}</span>;
}
SellerLink.propTypes = { auction: PropTypes.object.isRequired };
