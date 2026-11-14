import { useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { readLeaderboards } from '../lib/leaderboards';

const categories = [
    { key: 'volume', label: 'meat traded', color: '#9BBFF5' },
    { key: 'trades', label: 'total trades', color: '#76D0C4' },
    { key: 'donors', label: 'top donors', color: '#F2C66D' },
];
const positions = ['first', 'second', 'third'];

export function SellerLeaderboardHonorsView({ data, sellerId }) {
    const honors = categories.flatMap(category => {
        const player = data?.[category.key]?.find(row => row.id === sellerId && row.rank >= 1 && row.rank <= 3);
        return player ? [{ ...category, rank: player.rank }] : [];
    }).sort((a, b) => a.rank - b.rank);
    if (!honors.length) return null;
    return <ul className="public-profile-leaderboard-honors" aria-label="Leaderboard positions">
        {honors.map(honor => <li key={honor.key} style={{ color: honor.color }}>
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {honor.rank === 1 ? <><path d="m4 7 4.5 3L12 4l3.5 6L20 7l-2.5 10h-11L4 7Z" /><path d="M7 21h10" /></>
                    : <><path d="M7 3h10v5a5 5 0 0 1-10 0V3Z" /><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4l2 3H8l2-3Z" /></>}
            </svg>
            <span className="public-profile-honor-caption"><span aria-hidden="true">· </span>Ranks {positions[honor.rank - 1]} in {honor.label}</span>
        </li>)}
    </ul>;
}
SellerLeaderboardHonorsView.propTypes = { data: PropTypes.object, sellerId: PropTypes.string.isRequired };

export default function SellerLeaderboardHonors({ sellerId, visible }) {
    const { currentUser, authorizationScope } = useContext(UserContext);
    const userId = currentUser?.id;
    const scope = authorizationScope || userId;
    const allowed = Boolean(visible && userId && !currentUser?.isBanned);
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        if (!allowed) return;
        const controller = new AbortController();
        let cancelled = false;
        // One bounded private read per profile/authorization scope, no polling.
        // Keeping this component above the tabs avoids reads on tab/filter changes.
        readLeaderboards(supabase, controller.signal).then(data => {
            if (!cancelled) setSnapshot({ scope, sellerId, data });
        }).catch(() => { /* Optional honors must not prevent profile use. */ });
        return () => { cancelled = true; controller.abort(); };
    }, [allowed, scope, sellerId]);
    const data = allowed && snapshot?.scope === scope && snapshot.sellerId === sellerId ? snapshot.data : null;
    return <SellerLeaderboardHonorsView data={data} sellerId={sellerId} />;
}
SellerLeaderboardHonors.propTypes = { sellerId: PropTypes.string.isRequired, visible: PropTypes.bool.isRequired };
