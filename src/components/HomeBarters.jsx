import useBarterRead from '../hooks/useBarterRead';
import { useAuctionBoundaryNow } from '../hooks/useAuctionBoundaryNow';
import StaticAuctionStrip from './StaticAuctionStrip';

export default function HomeBarters() {
    // Reuse the bounded, viewer-scoped browse cache, coalescing and visible refresh.
    const { data, error, refresh } = useBarterRead('read_barter_auctions', { p_search: '', p_sort: 'newest', p_page: 1 });
    const rows = (data?.rows || []).map(row => ({ ...row, auctionKind: 'barter', status: 'active',
        escrowMode: false, minBidMeat: row.minimumValue || 0 }));
    const now = useAuctionBoundaryNow(rows);
    const active = rows.filter(row => row.endTime > now);
    return <StaticAuctionStrip auctions={active} now={now} title="Barters" label="Barters" className="mt-8"
        href="/barter?sort=newest" linkText="See all barters">
        {error && <p role="alert" className="text-sm">Barters could not be refreshed. <button onClick={refresh} className="text-blue-700 underline">Retry</button></p>}
        {!data && !error && <p role="status">Loading barters…</p>}
        {data && !active.length && <p className="text-sm text-gray-500">No active barters right now.</p>}
    </StaticAuctionStrip>;
}
