import { useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { compactLeaderboardValue as compact, readLeaderboards } from '../lib/leaderboards';
import SiteFooter from '../components/SiteFooter';
import './Leaderboards.css';
import LoyaltyProgress from '../components/LoyaltyProgress';

const number = value => value.toLocaleString('en-US');
const tabs = [
    { key: 'volume', label: 'Trade volume' },
    { key: 'trades', label: 'Completed trades' },
    { key: 'donors', label: 'Top donors' },
];

export function LeaderboardsPanel({ data = null, signedIn = false, loading = false, error = '', onRetry }) {
    const [activeTab, setActiveTab] = useState('volume');
    const [search, setSearch] = useState('');
    const isDonors = activeTab === 'donors';
    const ranked = data?.[activeTab] || [];
    const visible = ranked.filter(player => player.name.toLowerCase().includes(search.trim().toLowerCase()));
    const podium = visible.filter(player => player.rank <= 3);
    const remaining = visible.filter(player => player.rank > 3 && player.rank <= 10);
    const leaderboardTitle = tabs.find(tab => tab.key === activeTab)?.label;
    // Podium awards describe leaderboard placement, independently of loyalty membership.
    const awards = ['Diamond', 'Gold', 'Silver'];

    return <>
        <main className="club-page">
            <header className="club-page-header">
                <div>
                    <h1><span>kHub</span> Leaderboards</h1>
                </div>
            </header>

            <LoyaltyProgress />

            <section className="club-panel club-board" aria-labelledby="club-rankings-title">
                <div className="club-board-controls">
                    <div className="club-tabs" role="group" aria-label="Leaderboard category">
                        {tabs.map(tab => <button key={tab.key} type="button" className="bg-transparent" aria-pressed={activeTab === tab.key} onClick={() => { setActiveTab(tab.key); setSearch(''); }}>{tab.label}</button>)}
                    </div>
                    <label className="club-search"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={isDonors ? 'Find a donor…' : 'Find a trader…'} aria-label="Search leaderboard players" /></label>
                </div>
                <h2 id="club-rankings-title" className="club-ranking-heading">{leaderboardTitle}<span className="club-ranking-period"> · lifetime</span></h2>
                {isDonors && <p className="club-donor-note">Recorded Meat donations only; excludes commissions, items and gift packages.</p>}
                {podium.length > 0 && <ol className="club-podium" aria-label="Top three leaderboard awards">
                    {podium.map(player => <li key={player.id} className={`club-podium-place club-podium-place-${player.rank}`} value={player.rank}>
                        <div className="club-podium-person">
                            {player.rank === 1 && <svg className="club-podium-crown" viewBox="0 0 24 24" role="img" aria-label="First place crown" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m4 7 4.5 3L12 4l3.5 6L20 7l-2.5 10h-11L4 7Z" />
                                <path d="M7 21h10" />
                            </svg>}
                            <strong>{player.name}</strong>
                            <span className="club-podium-total" title={number(player.value)}>{activeTab === 'trades' ? number(player.value) : compact(player.value)}</span>
                        </div>
                        <div className="club-podium-step"><span>#{player.rank}</span><strong>{awards[player.rank - 1]}</strong></div>
                    </li>)}
                </ol>}
                {!signedIn && <p className="club-board-status"><Link to="/login">Log in</Link> to view the leaderboards.</p>}
                {loading && <p className="club-board-status" role="status">Loading leaderboards…</p>}
                {error && <p className="club-board-status" role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
                {data && <div className="club-table-wrap">
                    <table className="club-table">
                        <caption className="sr-only">{tabs.find(tab => tab.key === activeTab)?.label} leaderboard</caption>
                        <thead><tr><th scope="col">Rank / Player</th><th scope="col">{isDonors ? 'Total donated · Meat' : activeTab === 'trades' ? 'Completed trades' : 'Trade volume · Meat'}</th></tr></thead>
                        <tbody>{remaining.map(player => <tr key={player.id}>
                            <th scope="row"><div className="club-player"><span className="club-rank">{String(player.rank).padStart(2, '0')}</span><span className="club-player-info"><strong>{player.name}</strong></span></div></th>
                            <td>{activeTab === 'trades' ? number(player.value) : compact(player.value)}</td>
                        </tr>)}</tbody>
                    </table>
                    {visible.length === 0 && <div className="club-empty">{ranked.length ? 'No matching players.' : 'No qualifying players yet.'} <button type="button" onClick={() => setSearch('')}>Clear search</button></div>}
                </div>}
                {data && <div className="club-board-foot"><span>{visible.length} of {ranked.length} players</span><span>Updated {new Date(data.refreshedAt).toLocaleString()}</span></div>}
            </section>

            <p className="club-disclaimer">Trade rankings include both sides of completed Sell trades and paid Buy fulfillments. Loyalty progress counts completed escrow sales only.</p>
        </main>
        <SiteFooter />
    </>;
}

LeaderboardsPanel.propTypes = {
    data: PropTypes.object, signedIn: PropTypes.bool, loading: PropTypes.bool, error: PropTypes.string, onRetry: PropTypes.func,
};

export default function Leaderboards() {
    const { currentUser, authorizationScope } = useContext(UserContext);
    const userId = currentUser?.id;
    const scope = authorizationScope || userId;
    const [attempt, setAttempt] = useState(0);
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        if (!userId) return;
        const controller = new AbortController();
        let cancelled = false;
        readLeaderboards(supabase, controller.signal).then(data => {
            if (!cancelled) setSnapshot({ scope, attempt, data });
        }).catch(() => {
            if (!cancelled) setSnapshot({ scope, attempt, error: 'Leaderboards are unavailable. Please retry.' });
        });
        return () => { cancelled = true; controller.abort(); };
    }, [userId, scope, attempt]);
    const result = userId && snapshot?.scope === scope && snapshot.attempt === attempt ? snapshot : null;
    return <LeaderboardsPanel key={scope || 'guest'} signedIn={Boolean(userId)} data={result?.data || null}
        loading={Boolean(userId && !result)} error={result?.error || ''} onRetry={() => setAttempt(value => value + 1)} />;
}
