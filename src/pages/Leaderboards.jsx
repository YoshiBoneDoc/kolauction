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
    const tradeAmount = Math.max(0, Number(amount) || 0);
    const fee = Math.round(tradeAmount * tier.fee / 100);
    return <>
        <main className="lb-page">
            <div className="lb-preview"><span className="lb-dot" /> DESIGN PREVIEW <span>Sample players & illustrative tiers. Loyalty discounts are not active.</span></div>
            <header className="lb-hero">
                <div><p className="lb-eyebrow">THE kHUB TRADING CLUB</p><h1>Big trades.<br /><span>Bigger rewards.</span></h1><p>Meet the players moving the most Meat. Build your trading legacy and discover a little something for your loyalty.</p><a href="#loyalty" className="lb-hero-link">Explore loyalty rewards <span aria-hidden="true">↘</span></a></div>
                <div className="lb-hero-art" aria-hidden="true"><div className="lb-orbit" /><div className="lb-emblem">✦</div><span className="lb-art-caption">TRADE MORE. KEEP MORE.</span><span className="lb-art-star">✧</span></div>
            </header>
            <section className="lb-stats" aria-label="Sample community statistics">
                <div><span>Community trade volume</span><strong>{compact(players.reduce((sum, player) => sum + player.volume, 0))} <small>Meat</small></strong></div>
                <div><span>Completed trades</span><strong>{number(players.reduce((sum, player) => sum + player.trades, 0))}</strong></div>
                <div><span>Highest loyalty reward</span><strong>1% <small>escrow fee</small></strong></div>
            </section>
            <section className="lb-board" aria-labelledby="leaderboard-title">
                <div className="lb-section-heading"><div><p className="lb-eyebrow">THE HALL OF TRADERS</p><h2 id="leaderboard-title">Player leaderboards</h2><p>A little friendly competition. A whole lot of Meat.</p></div><span className="lb-pill">All-time · Sample data</span></div>
                <div className="lb-toolbar"><div className="lb-switch" aria-label="Rank players by"><button aria-pressed={sort === 'volume'} onClick={() => setSort('volume')}>Trade volume</button><button aria-pressed={sort === 'trades'} onClick={() => setSort('trades')}>Completed trades</button></div><label className="lb-search"><span aria-hidden="true">⌕</span><input aria-label="Search players" placeholder="Find a player…" value={search} onChange={event => setSearch(event.target.value)} type="search" /></label></div>
                <div className="lb-table-scroll"><table className="lb-table"><caption className="sr-only">Sample all-time players ranked by {sort === 'volume' ? 'trade volume' : 'completed trades'}</caption><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Loyalty tier</th><th scope="col">Trades</th><th scope="col">Volume · Meat</th><th scope="col">Escrow fee</th></tr></thead><tbody>{visible.map(player => { const playerTier = tierFor(player.volume); const rank = ranked.indexOf(player) + 1; return <tr key={player.name}><td><span className={`lb-rank lb-rank-${rank}`}>{String(rank).padStart(2, '0')}</span></td><th scope="row"><span className="lb-player"><span className={`lb-avatar ${playerTier.color}`} aria-hidden="true">{player.name.slice(0, 2).toUpperCase()}</span>{player.name}</span></th><td><span className={`lb-badge ${playerTier.color}`}><span aria-hidden="true">✦</span> {playerTier.name}</span></td><td>{number(player.trades)}</td><td className="lb-volume">{compact(player.volume)}</td><td>{playerTier.fee}%</td></tr>; })}</tbody></table>{visible.length === 0 && <div className="lb-empty"><strong>No players found</strong><p>Try another player name.</p><button onClick={() => setSearch('')}>Clear search</button></div>}</div>
                <div className="lb-board-foot">{visible.length} of {players.length} sample players <span>Rankings based on lifetime completed trades</span></div>
            </section>
            <section id="loyalty" className="lb-loyalty" aria-labelledby="loyalty-title">
                <div className="lb-section-heading"><div><p className="lb-eyebrow">LOYALTY THAT PAYS OFF</p><h2 id="loyalty-title">Your next trade goes further.</h2><p>The more you trade in total, the less you pay in escrow fees.</p></div><span className="lb-pill">Proposed rewards</span></div>
                <div className="lb-tiers">{tiers.map((item, index) => <button key={item.name} className={`lb-tier ${item.color}`} aria-pressed={selectedTier === index} onClick={() => setSelectedTier(index)}><span className="lb-tier-mark" aria-hidden="true">{item.mark}</span><strong>{item.name}</strong><span className="lb-tier-threshold">{item.minimum === 0 ? 'Start your journey' : `${compact(item.minimum)}+ Meat traded`}</span><span className="lb-tier-fee">{item.fee}% <small>escrow fee</small></span><span className="lb-tier-saving">{index === 0 ? 'The starting tier' : `${Math.round((1 - item.fee / tiers[0].fee) * 100)}% lower fees`}</span></button>)}</div>
                <div className="lb-calculator"><div><p className="lb-eyebrow">A LITTLE PREVIEW OF YOUR SAVINGS</p><h3>See what {tier.name} could save you.</h3><p>Select a tier above and enter a trade value.</p></div><label>Trade value in Meat<input type="number" min="0" max="1000000000000" step="1000000" value={amount} onChange={event => setAmount(event.target.value)} /></label><div className="lb-calculation"><span>Escrow fee at {tier.fee}%</span><strong>{number(fee)} <small>Meat</small></strong><span className="lb-savings">Save {number(Math.round(tradeAmount * tiers[0].fee / 100) - fee)} Meat vs. Copper</span></div></div>
                <div className="lb-how"><div><span>01</span><h3>Make a trade</h3><p>Buy or sell. Every completed trade would contribute to your lifetime total.</p></div><div><span>02</span><h3>Climb the tiers</h3><p>Reach the next volume milestone to unlock a better escrow rate.</p></div><div><span>03</span><h3>Keep more Meat</h3><p>Your loyalty rate would apply to future escrow trades as your total grows.</p></div></div>
                <p className="lb-disclaimer">Preview only. Player names, volumes, tier thresholds and fee rates are fictional. Eligibility, volume calculations and final reward rules will be confirmed before launch. This page does not change any current fees.</p>
            </section>
        </main><SiteFooter />
    </>;
}
