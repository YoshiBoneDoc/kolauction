import { useState } from 'react';
import SiteFooter from '../components/SiteFooter';
import './Leaderboards.css';

// CONCEPT PREVIEW ONLY. Replace fixtures and proposed rewards with verified server data before launch.
const tiers = [
    { name: 'Copper', minimum: 0, fee: 3, color: 'copper' },
    { name: 'Silver', minimum: 100_000_000, fee: 2.5, color: 'silver' },
    { name: 'Gold', minimum: 500_000_000, fee: 2, color: 'gold' },
    { name: 'Platinum', minimum: 2_000_000_000, fee: 1.5, color: 'platinum' },
    { name: 'Diamond', minimum: 10_000_000_000, fee: 1, color: 'diamond' },
];

const players = [
    { name: 'MeatMagnate', volume: 18_420_000_000, trades: 1248 },
    { name: 'DiscoBandit', volume: 12_860_000_000, trades: 986 },
    { name: 'PastamancerPrime', volume: 9_750_000_000, trades: 1102 },
    { name: 'SaucyMerchant', volume: 6_840_000_000, trades: 743 },
    { name: 'AccordionCollector', volume: 4_210_000_000, trades: 862 },
    { name: 'TheTurtleTrader', volume: 2_680_000_000, trades: 518 },
    { name: 'SealClubCapital', volume: 1_450_000_000, trades: 396 },
    { name: 'NoodleInvestor', volume: 780_000_000, trades: 284 },
    { name: 'CosmicPickle', volume: 320_000_000, trades: 167 },
    { name: 'TinyMeatEmpire', volume: 64_000_000, trades: 92 },
];

// Illustrative voluntary donations, NOT commissions or actual donor records.
const donors = [
    { name: 'GenerousGnome', donated: 125_000_000, donations: 8 },
    { name: 'MeatPatron', donated: 70_000_000, donations: 5 },
    { name: 'KindheartedKol', donated: 35_000_000, donations: 4 },
    { name: 'HelpfulHero', donated: 12_500_000, donations: 3 },
    { name: 'FriendlyTrader', donated: 5_000_000, donations: 2 },
];

const number = value => value.toLocaleString('en-US');
const compact = value => {
    if (value >= 1e9) return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1).replace(/\.?0+$/, '')}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(value % 1e3 === 0 ? 0 : 1).replace(/\.?0+$/, '')}k`;
    return number(value);
};
const tierFor = volume => [...tiers].reverse().find(tier => volume >= tier.minimum) || tiers[0];
const tabs = [
    { key: 'volume', label: 'Trade volume' },
    { key: 'trades', label: 'Completed trades' },
    { key: 'donors', label: 'Top donors' },
];

export default function Leaderboards() {
    const [activeTab, setActiveTab] = useState('volume');
    const [search, setSearch] = useState('');
    const [selectedTier, setSelectedTier] = useState(2);
    const isDonors = activeTab === 'donors';
    const ranked = [...(isDonors ? donors : players)].sort((a, b) =>
        (b[isDonors ? 'donated' : activeTab] - a[isDonors ? 'donated' : activeTab]) || a.name.localeCompare(b.name)
    );
    const visible = ranked.map((player, index) => ({ ...player, rank: index + 1 }))
        .filter(player => player.name.toLowerCase().includes(search.trim().toLowerCase()));
    const maxValue = ranked[0]?.[isDonors ? 'donated' : activeTab] || 1;
    const currentTier = tiers[selectedTier];

    return <>
        <main className="club-page">
            <header className="club-page-header">
                <div>
                    <h1>kHub Leaderboards</h1>
                    <p>Top traders, community supporters, and trading rewards.</p>
                </div>
                <span className="club-status">CONCEPT PREVIEW</span>
            </header>

            <section className="club-panel club-progression" aria-labelledby="club-rewards-title">
                <div className="club-heading-row">
                    <div>
                        <h2 id="club-rewards-title">Trading rewards</h2>
                        <p>Explore proposed lifetime trading milestones and escrow rates.</p>
                    </div>
                    <span className="club-preview-tag">Illustrative tiers</span>
                </div>
                <div className="club-tier-track" role="group" aria-label="Explore proposed reward tiers">
                    {tiers.map((tier, index) => <button
                        key={tier.name}
                        type="button"
                        className={`club-tier-step ${tier.color} ${selectedTier === index ? 'is-selected' : ''}`}
                        aria-pressed={selectedTier === index}
                        onClick={() => setSelectedTier(index)}
                    >
                        <span className="club-tier-segment" />
                        <span className="club-tier-title"><span className="club-tier-dot" />{tier.name}</span>
                        <span className="club-tier-threshold">{tier.minimum === 0 ? 'Starting tier' : `${compact(tier.minimum)}+ Meat`}</span>
                        <strong>{tier.fee}% <span>fee</span></strong>
                    </button>)}
                </div>
                <div className="club-tier-detail" aria-live="polite">
                    <div><span className={`club-tier-pill ${currentTier.color}`}>{currentTier.name}</span><span>{currentTier.minimum === 0 ? 'Starting tier' : `${compact(currentTier.minimum)}+ lifetime Meat traded`}</span></div>
                    <div><strong>{currentTier.fee}%</strong><span> proposed escrow rate</span></div>
                </div>
                <p className="club-rewards-note">This is an interactive tier preview, not your account progress. Qualification rules and rates are not final.</p>
            </section>

            <section className="club-panel club-board" aria-labelledby="club-rankings-title">
                <div className="club-heading-row club-board-heading">
                    <div><h2 id="club-rankings-title">Leaderboards</h2><p>All-time rankings · Sample players</p></div>
                    <span className="club-preview-tag">Sample data</span>
                </div>
                <div className="club-board-controls">
                    <div className="club-tabs" role="group" aria-label="Leaderboard category">
                        {tabs.map(tab => <button key={tab.key} type="button" aria-pressed={activeTab === tab.key} onClick={() => { setActiveTab(tab.key); setSearch(''); }}>{tab.label}</button>)}
                    </div>
                    <label className="club-search"><span aria-hidden="true">⌕</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={isDonors ? 'Find a donor…' : 'Find a trader…'} aria-label="Search leaderboard players" /></label>
                </div>
                {isDonors && <p className="club-donor-note">Donations are voluntary contributions, excluding escrow commissions. Donor names and amounts below are examples.</p>}
                <div className="club-table-wrap">
                    <table className="club-table">
                        <caption className="sr-only">Sample {tabs.find(tab => tab.key === activeTab)?.label} leaderboard</caption>
                        <thead><tr><th scope="col">Rank / Player</th>{isDonors ? <><th scope="col">Donations</th><th scope="col">Total donated · Meat</th></> : <><th scope="col">Completed trades</th><th scope="col">Trade volume · Meat</th></>}</tr></thead>
                        <tbody>{visible.map(player => {
                            const tier = isDonors ? null : tierFor(player.volume);
                            const primaryValue = player[isDonors ? 'donated' : activeTab];
                            return <tr key={player.name}>
                                <th scope="row"><div className="club-player"><span className={`club-rank ${player.rank <= 3 ? 'club-rank-top' : ''}`}>{String(player.rank).padStart(2, '0')}</span><span className={`club-avatar ${tier?.color || 'supporter'}`} aria-hidden="true">{player.name.slice(0, 2).toUpperCase()}</span><span className="club-player-info"><strong>{player.name}</strong><small className={tier?.color || 'supporter'}>{tier ? `◆ ${tier.name}` : 'Community supporter'}</small></span></div></th>
                                <td className={activeTab === 'trades' ? 'club-active-value' : ''}>{number(isDonors ? player.donations : player.trades)}</td>
                                <td className={activeTab !== 'trades' ? 'club-active-value' : ''}>{compact(isDonors ? player.donated : player.volume)}<span className="club-volume-bar" aria-hidden="true"><i style={{ width: `${primaryValue / maxValue * 100}%` }} /></span></td>
                            </tr>;
                        })}</tbody>
                    </table>
                    {visible.length === 0 && <div className="club-empty">No matching players. <button type="button" onClick={() => setSearch('')}>Clear search</button></div>}
                </div>
                <div className="club-board-foot"><span>{visible.length} of {ranked.length} sample players</span><span>Illustrative lifetime totals</span></div>
            </section>

            <p className="club-disclaimer">Concept preview only. All players, donations, rankings, tier thresholds, and reward rates shown are sample data. Rewards are not active and current fees are unchanged.</p>
        </main>
        <SiteFooter />
    </>;
}
