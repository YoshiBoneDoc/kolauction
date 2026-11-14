import { useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { compactLeaderboardValue as compact, readLeaderboards, searchLeaderboards } from '../lib/leaderboards';
import SiteFooter from '../components/SiteFooter';
import './Leaderboards.css';
import LoyaltyProgress from '../components/LoyaltyProgress';
import LeaderboardPrivileges from '../components/LeaderboardPrivileges';
import { getLeaderboardFeeBenefits } from '../lib/leaderboardFeePreview';

const number = value => value.toLocaleString('en-US');
const tabs = [
    { key: 'volume', label: 'Meat traded' },
    { key: 'trades', label: 'Total trades' },
    { key: 'donors', label: 'Top donors' },
];

export function LeaderboardsPanel({ data = null, signedIn = false, loading = false, error = '', onRetry, onSearch, searchState = null, viewerId = null }) {
    const [activeTab, setActiveTab] = useState('volume');
    const [search, setSearch] = useState('');
    const benefit = getLeaderboardFeeBenefits(data, viewerId);
    const isDonors = activeTab === 'donors';
    const ranked = data?.[activeTab] || [];
    const searching = Boolean(search.trim());
    const remote = searchState?.query === search.trim() && searchState?.category === activeTab ? searchState : null;
    const visible = searching && onSearch ? (remote?.rows || []) : ranked.filter(player => player.name.toLowerCase().includes(search.trim().toLowerCase()));
    const podium = (searching ? [] : visible).filter(player => player.rank <= 3);
    const remaining = visible.filter(player => searching || (player.rank > 3 && player.rank <= 10));
    const leaderboardTitle = tabs.find(tab => tab.key === activeTab)?.label;

    return <>
        <main className="club-page">
            <header className="club-page-header">
                <div>
                    <h1><span>kHub</span> Leaderboards</h1>
                </div>
            </header>

            <LoyaltyProgress leaderboardBenefit={benefit}>
                <div className="club-personal-stat" aria-live="polite" aria-atomic="true">
                    <h3>{isDonors ? 'Your donations' : activeTab === 'trades' ? 'Your total trades' : 'Your Meat traded'}<span className="club-personal-period"> · Lifetime</span></h3>
                    {data?.personal ? <>
                        <p className="club-personal-total" title={number(data.personal[activeTab])}>{activeTab === 'trades' ? number(data.personal[activeTab]) : `${number(data.personal[activeTab])} Meat`}</p>
                    </> : <p className="club-personal-caption">{!signedIn ? 'Log in to see your total.' : loading ? 'Loading your total…' : 'Your total is unavailable.'}</p>}
                </div>
            </LoyaltyProgress>

            <section className="club-panel club-board" aria-labelledby="club-rankings-title">
                <div className="club-board-controls">
                    <div className="club-tabs" role="group" aria-label="Leaderboard category">
                        {tabs.map(tab => <button key={tab.key} type="button" className="bg-transparent" aria-pressed={activeTab === tab.key} onClick={() => { setActiveTab(tab.key); setSearch(''); onSearch?.('', tab.key, 0); }}>{tab.label}</button>)}
                    </div>
                    <label className="club-search"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" disabled={!signedIn || !data} value={search} maxLength={120} onChange={event => { setSearch(event.target.value); onSearch?.(event.target.value, activeTab, 0); }} placeholder={isDonors ? 'Find a donor…' : 'Find a trader…'} aria-label="Search leaderboard players" /></label>
                </div>
                <h2 id="club-rankings-title" className="club-ranking-heading">{leaderboardTitle}<span className="club-ranking-period"> · lifetime</span>{!isDonors && <span className="club-ranking-types">(All trade types)</span>}{isDonors && <span className="club-donor-waiver-note">The current top donor has all escrow fees waived.</span>}</h2>
                {podium.length > 0 && <ol className="club-podium" aria-label="Top three leaderboard awards">
                    {podium.map(player => <li key={player.id} className={`club-podium-place club-podium-place-${player.rank}`} value={player.rank}>
                        <div className="club-podium-person">
                            {player.rank === 1 && <svg className="club-podium-crown" style={{ color: activeTab === 'volume' ? '#9BBFF5' : activeTab === 'donors' ? '#F2C66D' : '#76D0C4' }} viewBox="0 0 24 24" role="img" aria-label="First place crown" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m4 7 4.5 3L12 4l3.5 6L20 7l-2.5 10h-11L4 7Z" />
                                <path d="M7 21h10" />
                            </svg>}
                            {player.rank > 1 && <svg className="club-podium-trophy" style={{ color: activeTab === 'volume' ? '#9BBFF5' : activeTab === 'donors' ? '#F2C66D' : '#76D0C4' }} viewBox="0 0 24 24" role="img" aria-label={player.rank === 2 ? 'Second place trophy' : 'Third place trophy'} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M7 3h10v5a5 5 0 0 1-10 0V3Z" /><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4l2 3H8l2-3Z" />
                            </svg>}
                            <strong><Link to={`/seller/${player.id}`}>{player.name}</Link></strong>
                            <span className="club-podium-total" title={number(player.value)}>{activeTab === 'trades' ? number(player.value) : compact(player.value)}</span>
                        </div>
                        <div className="club-podium-step"><span>{player.rank}</span><small>{['First place', 'Second place', 'Third place'][player.rank - 1]}</small></div>
                    </li>)}
                </ol>}
                {!signedIn && <p className="club-board-status"><Link to="/login">Log in</Link> to view the leaderboards.</p>}
                {loading && <p className="club-board-status" role="status">Loading leaderboards…</p>}
                {error && <p className="club-board-status" role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
                {searching && onSearch && !remote && <p className="club-board-status" role="status">Searching players…</p>}
                {searching && remote?.error && <p className="club-board-status" role="alert">Search is unavailable. <button type="button" onClick={() => onSearch(search, activeTab, remote.offset)}>Retry</button></p>}
                {data && (!searching || !onSearch || remote?.rows) && <div className="club-table-wrap">
                    <table className="club-table">
                        <caption className="sr-only">{tabs.find(tab => tab.key === activeTab)?.label} leaderboard</caption>
                        <thead><tr><th scope="col">Rank / Player</th><th scope="col">{isDonors ? 'Total donated · Meat' : activeTab === 'trades' ? 'Total trades' : 'Meat traded'}</th></tr></thead>
                        <tbody>{remaining.map(player => <tr key={player.id}>
                            <th scope="row"><div className="club-player"><span className="club-rank">{player.rank === null ? '—' : String(player.rank).padStart(2, '0')}</span><span className="club-player-info"><strong><Link to={`/seller/${player.id}`}>{player.name}</Link></strong></span></div></th>
                            <td>{activeTab === 'trades' ? number(player.value) : compact(player.value)}</td>
                        </tr>)}</tbody>
                    </table>
                    {visible.length === 0 && <div className="club-empty">{searching ? 'No matching players.' : 'No qualifying players yet.'} <button type="button" onClick={() => { setSearch(''); onSearch?.('', activeTab, 0); }}>Clear search</button></div>}
                </div>}
                {searching && remote?.rows && <nav className="club-search-pages" aria-label="Search results pages">
                    <button type="button" disabled={!remote.offset} onClick={() => onSearch(search, activeTab, remote.offset - 20)}>Previous</button>
                    <span>Page {Math.floor(remote.offset / 20) + 1}</span>
                    <button type="button" disabled={!remote.more || remote.offset >= 10000} onClick={() => onSearch(search, activeTab, remote.offset + 20)}>Next</button>
                </nav>}
            </section>
            <LeaderboardPrivileges />
        </main>
        <SiteFooter />
    </>;
}

LeaderboardsPanel.propTypes = {
    data: PropTypes.object, signedIn: PropTypes.bool, loading: PropTypes.bool, error: PropTypes.string, onRetry: PropTypes.func, onSearch: PropTypes.func, searchState: PropTypes.object, viewerId: PropTypes.string,
};

export default function Leaderboards() {
    const { currentUser, authorizationScope } = useContext(UserContext);
    const userId = currentUser?.id;
    const scope = authorizationScope || userId;
    const [attempt, setAttempt] = useState(0);
    const [snapshot, setSnapshot] = useState(null);
    const [searchRequest, setSearchRequest] = useState(null);
    const [searchResult, setSearchResult] = useState(null);
    useEffect(() => {
        if (!userId || !searchRequest?.query || searchRequest.scope !== scope) return;
        const controller = new AbortController();
        let cancelled = false;
        const timer = setTimeout(() => {
            searchLeaderboards(supabase, searchRequest.category, searchRequest.query, searchRequest.offset, controller.signal).then(result => {
                if (!cancelled) setSearchResult({ ...searchRequest, ...result, scope });
            }).catch(() => {
                if (!cancelled) setSearchResult({ ...searchRequest, error: true, scope });
            });
        }, 300);
        return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
    }, [userId, scope, searchRequest]);
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
    const onSearch = (query, category, offset) => {
        setSearchResult(null);
        setSearchRequest({ query: query.trim(), category, offset, scope });
    };
    return <LeaderboardsPanel key={scope || 'guest'} viewerId={userId} signedIn={Boolean(userId)} data={result?.data || null}
        loading={Boolean(userId && !result)} error={result?.error || ''} onSearch={onSearch} searchState={searchResult?.scope === scope ? searchResult : null} onRetry={() => setAttempt(value => value + 1)} />;
}
