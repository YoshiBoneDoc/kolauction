import PropTypes from 'prop-types';
import useAuctionBookmarkCounts from '../hooks/useAuctionBookmarkCounts';

export default function AuctionWatching({ auctionId }) {
    const counts = useAuctionBookmarkCounts([{ id: auctionId }]);
    const count = counts[auctionId];
    if (!(count > 0)) return null;
    return <span className="absolute right-14 top-2 whitespace-nowrap text-[11px] leading-4 text-red-700 dark:text-red-400 sm:right-16"
        aria-live="polite" title="Players who have bookmarked this auction">{count.toLocaleString('en-US')} Watching</span>;
}
AuctionWatching.propTypes = { auctionId: PropTypes.string.isRequired };
