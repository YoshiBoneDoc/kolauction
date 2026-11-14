import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import useBarterRead from '../hooks/useBarterRead';

export default function BarterPendingBids() {
    const { currentUser } = useContext(UserContext);
    const { data, error, refresh } = useBarterRead('read_barter_pending', {}, Boolean(currentUser && !currentUser.isBanned));
    if (error) return <p className="mx-auto max-w-6xl px-4 text-xs" role="alert">Pending barter bids unavailable. <button onClick={refresh}>Retry</button></p>;
    if (!data?.length) return null;
    return <aside aria-label="Barter bid notices" className="mb-2 w-full px-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
        {data.map(row => <Link key={row.id} to={`/barter/${row.id}`} className="barter-pending-notice flex min-h-8 w-full flex-wrap items-center gap-2 rounded border px-4 py-0.5 text-sm">
            <span><strong>{row.kind === 'changes_requested' ? 'Changes requested on your bid' : 'Pending bids to review'}</strong> - {row.item}</span>{row.count > 1 && <span className="barter-pending-count inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold">{row.count}</span>}
        </Link>)}
        </div>
    </aside>;
}
