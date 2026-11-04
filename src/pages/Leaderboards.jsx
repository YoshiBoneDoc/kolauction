import { useState } from 'react';
import SiteFooter from '../components/SiteFooter';
import './Leaderboards.css';

// Preview fixtures only. Replace with completed-trade totals when loyalty launches.
const tiers = [
    { name: 'Copper', minimum: 0, fee: 3, mark: 'I', color: 'copper' },
    { name: 'Silver', minimum: 100000000, fee: 2.5, mark: 'II', color: 'silver' },
    { name: 'Gold', minimum: 500000000, fee: 2, mark: 'III', color: 'gold' },
    { name: 'Platinum', minimum: 2000000000, fee: 1.5, mark: 'IV', color: 'platinum' },
    { name: 'Diamond', minimum: 10000000000, fee: 1, mark: 'V', color: 'diamond' },
];
const players = [
    { name: 'MeatMagnate', volume: 18420000000, trades: 1248 },
    { name: 'DiscoBandit', volume: 12860000000, trades: 986 },
    { name: 'PastamancerPrime', volume: 9750000000, trades: 1102 },
    { name: 'SaucyMerchant', volume: 6840000000, trades: 743 },
    { name: 'AccordionCollector', volume: 4210000000, trades: 862 },
    { name: 'TheTurtleTrader', volume: 2680000000, trades: 518 },
    { name: 'SealClubCapital', volume: 1450000000, trades: 396 },
    { name: 'NoodleInvestor', volume: 780000000, trades: 284 },
    { name: 'CosmicPickle', volume: 320000000, trades: 167 },
    { name: 'TinyMeatEmpire', volume: 64000000, trades: 92 },
];
const tierFor = volume => [...tiers].reverse().find(tier => volume >= tier.minimum);
const compact = value => value >= 1e9 ? `${(value / 1e9).toFixed(2).replace(/\.00$/, '')}B` : `${(value / 1e6).toFixed(0)}M`;
const number = value => value.toLocaleString('en-US');

export default function Leaderboards() {
    const [sort, setSort] = useState('volume');
    const [search, setSearch] = useState('');
    const [selectedTier, setSelectedTier] = useState(2);
    const [amount, setAmount] = useState('10000000');
    const ranked = [...players].sort((a, b) => b[sort] - a[sort]);
    const visible = ranked.filter(player => player.name.toLowerCase().includes(search.trim().toLowerCase()));
    const tier = tiers[selectedTier];
    const tradeAmount = Math.min(1000000000000, Math.max(0, Number(amount) || 0));
    const fee = Math.round(tradeAmount * tier.fee / 100);
    const savings = Math.round(tradeAmount * tiers[0].fee / 100) - fee;
    const leader = ranked[0];
    return <>
        <main className="club-page">
            <div className="club-notice"><span className="club-status">CONCEPT PREVIEW</span><span>Sample rankings. Proposed rewards are not active.</span></div>
            <header className="club-hero">
                <div className="club-hero-copy"><p className="club-eyebrow">kHUB / THE TRADING CLUB</p><h1>Good trades.<br /><em>Great company.</em></h1><p>A place for the dealmakers, collectors, and Meat movers.<br className="club-desktop-break" /> Explore the ranks. Find your next milestone.</p><div className="club-hero-actions"><a href="#rankings">Explore the rankings <span aria-hidden="true">↗</span></a><a href="#rewards">Discover the tiers <span aria-hidden="true">↓</span></a></div></div>
                <div className="club-membership" aria-label="Illustrative Diamond membership card"><div className="club-card-top"><span>kH<span> / TRADING CLUB</span></span><span>✧</span></div><div className="club-card-emblem" aria-hidden="true">◈</div><div className="club-card-bottom"><div><small>THE NEXT LEVEL OF TRADING</small><strong>Diamond status</strong></div><span>V</span></div><div className="club-card-strip">MEMBERSHIP CONCEPT <span>EST. 2026</span></div></div>
            </header>
            <div className="club-metrics" aria-label="Illustrative community statistics"><div><span className="club-metric-icon" aria-hidden="true">↗</span><div><small>Sample trade volume</small><strong>{compact(players.reduce((sum, player) => sum + player.volume, 0))}<span> Meat</span></strong></div></div><div><span className="club-metric-icon" aria-hidden="true">⇄</span><div><small>Sample completed trades</small><strong>{number(players.reduce((sum, player) => sum + player.trades, 0))}</strong></div></div><div><span className="club-metric-icon" aria-hidden="true">◈</span><div><small>Five tiers. One journey.</small><strong>Copper <span>through</span> Diamond</strong></div></div></div>
            <div className="club-layout">
                <section id="rankings" className="club-board club-panel" aria-labelledby="club-rankings-title">
                    <div className="club-section-head"><div><p className="club-eyebrow">THE HALL OF TRADERS</p><h2 id="club-rankings-title">A league of their own.</h2></div><span className="club-label">All-time · Sample</span></div>
                    <div className="club-switch" aria-label="Rank players by"><button aria-pressed={sort === 'volume'} onClick={() => setSort('volume')}>Trade volume</button><button aria-pressed={sort === 'trades'} onClick={() => setSort('trades')}>Completed trades</button></div>
                    <div className="club-spotlight"><span className="club-laurel" aria-hidden="true">♛</span><div><small>TOP {sort === 'volume' ? 'MEAT MOVER' : 'DEALMAKER'}</small><strong>{leader.name}</strong><span>Diamond trader · Sample player</span></div><div className="club-spotlight-value"><strong>{sort === 'volume' ? compact(leader.volume) : number(leader.trades)}</strong><span>{sort === 'volume' ? 'Meat traded' : 'completed trades'}</span></div></div>
                    <label className="club-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search sample players" placeholder="Find a trader in the ranks…" value={search} onChange={event => setSearch(event.target.value)} /><span>{players.length} traders</span></label>
                    <div className="club-table-wrap"><table className="club-table"><caption className="sr-only">Sample players ranked by {sort === 'volume' ? 'trade volume' : 'completed trades'}</caption><thead><tr><th scope="col">Rank / Trader</th><th scope="col">Trades</th><th scope="col">Volume · Meat</th></tr></thead><tbody>{visible.map(player => { const playerTier = tierFor(player.volume); const rank = ranked.indexOf(player) + 1; return <tr key={player.name}><th scope="row"><div className="club-player"><span className={`club-rank ${rank <= 3 ? 'club-rank-top' : ''}`}>{String(rank).padStart(2, '0')}</span><span className={`club-avatar ${playerTier.color}`} aria-hidden="true">{player.name.slice(0, 2).toUpperCase()}</span><span className="club-player-info"><strong>{player.name}</strong><small className={playerTier.color}>◆ {playerTier.name}</small></span></div></th><td className={sort === 'trades' ? 'club-active-value' : ''}>{number(player.trades)}</td><td className={sort === 'volume' ? 'club-active-value' : ''}>{compact(player.volume)}<span className="club-volume-bar" aria-hidden="true"><i style={{ width: `${player.volume / players[0].volume * 100}%` }} /></span></td></tr>; })}</tbody></table>{visible.length === 0 && <div className="club-empty"><strong>No traders found.</strong><button onClick={() => setSearch('')}>Clear search</button></div>}</div>
                    <div className="club-board-foot"><span>{visible.length} of {players.length} sample traders</span><span>Illustrative lifetime totals</span></div>
                </section>
                <aside className="club-rewards" id="rewards" aria-labelledby="club-rewards-title">
                    <section className="club-panel club-tier-panel"><div className="club-section-head"><div><p className="club-eyebrow">BUILT FOR THE LONG GAME</p><h2 id="club-rewards-title">Every trade adds up.</h2></div></div><p className="club-description">Five milestones. Better proposed escrow rates.<br />Select a tier to explore the possibilities.</p><div className="club-tier-list">{tiers.map((item, index) => <button key={item.name} className={`club-tier ${item.color}`} aria-pressed={selectedTier === index} onClick={() => setSelectedTier(index)}><span className="club-tier-mark" aria-hidden="true">{item.mark}</span><span className="club-tier-name"><strong>{item.name}</strong><small>{item.minimum === 0 ? 'Your starting point' : `${compact(item.minimum)}+ Meat traded`}</small></span><span className="club-tier-rate"><strong>{item.fee}%</strong><small>proposed fee</small></span><span className="club-tier-check" aria-hidden="true">{selectedTier === index ? '✓' : '○'}</span></button>)}</div><p className="club-tier-note">Lifetime trade volume · Illustrative thresholds</p></section>
                    <section className="club-calculator club-panel" aria-labelledby="club-calculator-title"><div className="club-section-head"><div><p className="club-eyebrow">KEEP A LITTLE MORE MEAT</p><h2 id="club-calculator-title">Run the numbers.</h2></div><span className={`club-selected-tier ${tier.color}`}>{tier.name}</span></div><label htmlFor="club-amount">Hypothetical trade value <span>Meat</span></label><input id="club-amount" type="number" min="0" max="1000000000000" step="1000000" value={amount} onChange={event => setAmount(event.target.value)} /><div className="club-presets">{[1000000, 10000000, 100000000].map(value => <button key={value} aria-pressed={tradeAmount === value} onClick={() => setAmount(String(value))}>{compact(value)}</button>)}</div><div className="club-fee-line"><span>Copper reference · 3%</span><strong>{number(Math.round(tradeAmount * .03))}</strong></div><div className="club-fee-line"><span>{tier.name} concept · {tier.fee}%</span><strong>{number(fee)}</strong></div><div className="club-savings" aria-live="polite" aria-atomic="true"><div><span>Potential savings</span><strong>{number(savings)} <small>Meat</small></strong></div><span className="club-saving-percent">{Math.round((1 - tier.fee / 3) * 100)}%<small>lower fee</small></span></div><p className="club-calc-note">Illustrative flat-rate comparison, not a quote. Current tiered escrow fees remain unchanged.</p></section>
                </aside>
            </div>
            <section className="club-journey" aria-label="How proposed loyalty would work"><div><span>01</span><div><h3>Trade together.</h3><p>Completed buys and sells would build your lifetime volume.</p></div></div><div><span>02</span><div><h3>Find your next tier.</h3><p>Volume milestones would mark your progress from Copper to Diamond.</p></div></div><div><span>03</span><div><h3>Make more of it.</h3><p>Proposed discounts would reward your future escrow trades.</p></div></div></section>
            <footer className="club-disclaimer"><strong>A look at what could come next.</strong><p>Concept preview only. All players, rankings, thresholds, and reward rates shown here are sample data. Rewards are not active. Final eligibility and reward rules have not been set; this preview does not affect current fees or account status.</p></footer>
        </main><SiteFooter />
    </>;
}
