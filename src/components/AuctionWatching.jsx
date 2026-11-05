import useAdminAuctionBookmarkers from '../hooks/useAdminAuctionBookmarkers';
import PropTypes from 'prop-types';
import useAuctionBookmarkCounts from '../hooks/useAuctionBookmarkCounts';

export default function AuctionWatching({ auctionId }) {
    const counts = useAuctionBookmarkCounts([{ id: auctionId }]);
    const count = counts[auctionId];
    const bookmarkers = useAdminAuctionBookmarkers([{ id: auctionId }]);
    if (!(count > 0)) return null;
    return <div className="absolute right-14 top-2 max-w-[calc(100%-5rem)] text-right text-[11px] leading-4 text-red-700 dark:text-red-400 sm:right-16" aria-live="polite">
        <span title="Players who have bookmarked this auction">{count.toLocaleString('en-US')} Watching</span>
        {bookmarkers.admin && bookmarkers.loaded && !bookmarkers.error && bookmarkers.names[auctionId]?.length > 0 && <span className="block max-w-52 break-words text-[10px] leading-3 text-gray-500 dark:text-gray-400" title="Bookmarked by (admin only)">{bookmarkers.names[auctionId].join(', ')}</span>}
    </div>;
}
AuctionWatching.propTypes = { auctionId: PropTypes.string.isRequired };
