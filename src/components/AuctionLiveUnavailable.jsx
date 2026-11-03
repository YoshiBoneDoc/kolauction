import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';

// Catalogue-only rendering deliberately contains no price, countdown, outcome,
// availability, seller/bidder status or transaction controls.
export default function AuctionLiveUnavailable({ auction }) {
    return <article className="rounded border bg-white p-4 text-center">
        <Link to={`/auction/${auction.id}`} className="font-bold text-blue-700 underline">
            {auction.image && <img src={auction.image} alt="" loading="lazy" className="mx-auto mb-2 h-12 w-12 object-contain" />}
            {auction.item}
        </Link>
        <p role="status" className="mt-2 text-sm text-gray-600">Live auction information is temporarily unavailable. Bidding information will return after verification.</p>
    </article>;
}
AuctionLiveUnavailable.propTypes = { auction: PropTypes.object.isRequired };
