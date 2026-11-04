import useAdminAuctionBookmarkers from '../hooks/useAdminAuctionBookmarkers';
import PropTypes from 'prop-types';
import useAuctionBookmarkCounts from '../hooks/useAuctionBookmarkCounts';

export default function AuctionWatching({ auctionId }) {
    const counts = useAuctionBookmarkCounts([{ id: auctionId }]);
    const count = counts[auctionId];
    const bookmarkers = useAdminAuctionBookmarkers([{ id: auctionId }]);
    return <>
        {count > 0 && <span className="absolute right-14 top-2 whitespace-nowrap text-[11px] leading-4 text-red-700 dark:text-red-400 sm:right-16"
            aria-live="polite" title="Players who have bookmarked this auction">{count.toLocaleString('en-US')} Watching</span>}
        {bookmarkers.admin && <div className="mb-3 mt-6 rounded border border-gray-200 px-3 py-2 text-xs text-gray-600">
            <strong>Bookmarked by (admin only): </strong>
            {bookmarkers.error ? 'Names unavailable.' : !bookmarkers.loaded ? 'Loading…' : (bookmarkers.names[auctionId] || []).join(', ') || 'No current bookmarks.'}
        </div>}
    </>;
}
AuctionWatching.propTypes = { auctionId: PropTypes.string.isRequired };
