import PropTypes from 'prop-types';
import { auctionEndTime } from '../lib/auctionBrowsing';

export default function AuctionEndedTime({ auction, compact = true }) {
    const endedAt = new Date(auctionEndTime(auction));
    const [label, color] = {
        completed: ['Ended', 'text-[#27804A]'],
        ended_no_bids: ['Expired', 'text-[#A85D45]'],
        expired: ['Expired', 'text-[#A85D45]'],
        cancelled: ['Cancelled', 'text-[#64748B]'],
        voided: ['Cancelled', 'text-[#64748B]'],
    }[auction.status] || ['Auction ended', 'text-[#397B79]'];
    return <p className={`${compact ? 'w-full text-center text-[11px] leading-4' : 'text-sm leading-6'} ${color}`}>
        {label}: <time dateTime={endedAt.toISOString()}>{endedAt.toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        })}</time>
    </p>;
}

AuctionEndedTime.propTypes = { auction: PropTypes.object.isRequired, compact: PropTypes.bool };
