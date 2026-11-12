import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import GiveawayItemImage from './GiveawayItemImage';
import { itemImageUrl } from '../lib/itemCatalog';
import { formatCompactMeat } from '../lib/formatMeat';
import { raffleCountdown } from '../lib/raffles';
import { createMarketPriceService } from '../lib/marketPrices';
import { supabase } from '../lib/supabase';
import { UserContext } from '../context/UserContext';
import { useContext } from 'react';
import mysteryBox from '../assets/raffle-mystery-box.svg';
import { rafflePrizePositions, raffleBoxCenter } from '../lib/rafflePrizeCurve';
import './raffles.css';

const prices = createMarketPriceService(supabase);
const quantity = value => BigInt(value).toLocaleString('en-US');
const raffleReminderOptions = [[60, '1 hour'], [360, '6 hours'], [720, '12 hours'], [1440, '1 day'], [4320, '3 days']];
function RaffleReminder({ raffle }) {
    const { currentUser } = useContext(UserContext);
    const [open, setOpen] = useState(false);
    const [minutes, setMinutes] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        setOpen(false); setMinutes(null); setError('');
        if (currentUser?.id && raffle.id) supabase.rpc('read_raffle_reminder', { p_id: raffle.id }).then(({ data, error: failure }) => {
            if (active && !failure) setMinutes(data);
        });
        return () => { active = false; };
    }, [raffle.id, currentUser?.id]);
    if (!currentUser?.id || currentUser.isAdmin || currentUser.id === raffle.creator_id) return null;
    async function choose(value) {
        setBusy(true); setError('');
        try {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
            const { error: failure } = await supabase.rpc('set_raffle_reminder', { p_id: raffle.id, p_minutes: value, p_time_zone: zone });
            if (failure) throw failure;
            setMinutes(value); setOpen(false);
        } catch { setError('Reminder could not be saved. Please try again.'); }
        finally { setBusy(false); }
    }
    return <div className="raffle-reminder">
        {!open ? <button type="button" onClick={() => setOpen(true)}>{minutes ? 'Reminder set · Change' : 'Remind me'}</button> :
            <label>When? <select aria-label="Raffle reminder time" disabled={busy} value="" onChange={event => choose(Number(event.target.value))}>
                <option value="" disabled>Choose a time</option>
                {raffleReminderOptions.filter(([value]) => Date.parse(raffle.ends_at) - value * 60000 > Date.now()).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><button type="button" onClick={() => setOpen(false)}>Cancel</button></label>}
        {error && <span role="alert">{error}</span>}
    </div>;
}
RaffleReminder.propTypes = { raffle: PropTypes.object.isRequired };

export function RafflePrizeDisplay({ raffle, marketPrices = new Map(), winnerResult = null, now = Date.now() }) {
    const selected = raffle.prizes.find(p => p.outcome === raffle.selected_outcome);
    const canceled = raffle.completion_reason === 'cancelled' || raffle.state === 'cancelled';
    const empty = raffle.completion_reason === 'no_tickets' || raffle.state === 'empty';
    const concluded = !canceled && !empty && (raffle.state === 'settled' || raffle.completion_reason === 'prize_delivered');
    const closed = Date.parse(raffle.ends_at) <= now;
    const status = canceled ? 'Canceled' : empty ? 'No tickets' : concluded ? 'Concluded' : raffle.state === 'preview' ? 'Preview' : selected ? 'Prize selected' : closed ? 'Finalizing tickets…' : 'Active';
    const value = prize => {
        const record = marketPrices.get(prize.item_id);
        return record?.available ? BigInt(record.price_meat) * BigInt(prize.quantity) : null;
    };
    const pool = [...raffle.prizes].sort((a, b) => {
        const left = value(a), right = value(b);
        return left === right ? a.outcome - b.outcome : left === null ? 1 : right === null ? -1 : left > right ? -1 : 1;
    });
    const values = pool.map(value);
    const liveRange = values.length && values.every(v => v !== null) ? {
        min: values.reduce((a, b) => a < b ? a : b),
        max: values.reduce((a, b) => a > b ? a : b),
    } : null;
    const frozen = raffle.prize_range_frozen_at || selected || concluded || canceled || empty;
    const range = frozen ? (raffle.prize_range_min != null && raffle.prize_range_max != null ? {
        min: BigInt(raffle.prize_range_min), max: BigInt(raffle.prize_range_max),
    } : null) : liveRange;
    const prizeArea = useRef(null);
    const [areaSize, setAreaSize] = useState({ width: 500, height: 326 });
    useEffect(() => {
        if (!prizeArea.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) setAreaSize(old => old.width === width && old.height === height ? old : { width, height });
        });
        observer.observe(prizeArea.current);
        return () => observer.disconnect();
    }, []);
    const positions = rafflePrizePositions(pool.length, areaSize.width, areaSize.height);
    const boxCenter = raffleBoxCenter(positions, areaSize.width, areaSize.height);
    const entryHeight = pool.some(prize => prize.name.length > 32) ? 128 : 96;
    const sceneHeight = Math.max(340, (pool.length - 1) * entryHeight / 0.84 + 70);
    return <article className={`raffle-summary raffle-showcase ${selected ? 'raffle-has-selection' : ''}`}>
        <header className="raffle-showcase-heading">
            <div className="raffle-badges"><span className="raffle-label">Raffle</span>{raffle.raffle_number && <span>#{raffle.raffle_number}</span>}</div>
            <div className="raffle-showcase-titleline"><h2>{raffle.name}</h2>
        <div className="raffle-facts"><strong>{quantity(raffle.ticket_price)} Meat <small>/ ticket</small></strong></div></div>
            <div className="raffle-status-line">{!closed && <span className={`raffle-header-countdown ${Date.parse(raffle.ends_at) - now < 3600000 ? 'is-urgent' : ''}`}>{raffleCountdown(raffle.ends_at, now)}</span>}<span className={`raffle-showcase-status ${concluded ? 'is-concluded' : status === 'Active' ? 'is-active' : ''}`}>{status}</span>{status === 'Active' && <RaffleReminder raffle={raffle} />}</div>
        </header>
        <h3 className="raffle-pool-heading" style={{ '--first-prize-offset': `${(positions[0]?.x ?? 5) * areaSize.width / 100}px` }}>Possible prizes</h3>
        <div className="raffle-prize-range-row" style={{ '--first-prize-offset': `${(positions[0]?.x ?? 5) * areaSize.width / 100}px` }}><span className="raffle-prize-value-range" title={range ? `Approximate current Mall value per prize, quantity included: ${quantity(range.min)}–${quantity(range.max)} Meat` : 'Market value unavailable for one or more prizes'}>{range ? `Ranging from ${formatCompactMeat(range.min, 2)} to ${formatCompactMeat(range.max, 2)} meat` : 'Prize range unavailable.'}</span></div>
        <div className="raffle-prize-scene" style={{ '--scene-height': `${sceneHeight}px` }}>
            <div className={`raffle-mystery-art ${boxCenter ? 'raffle-box-balanced' : ''}`} style={boxCenter ? { '--box-center-x': `${boxCenter.x}px`, '--box-center-y': `${boxCenter.y}px` } : undefined} aria-hidden="true">
                <div className="raffle-box-illustration"><span className="raffle-question q-one">?</span><span className="raffle-question q-two">?</span><span className="raffle-question q-three">?</span><span className="raffle-question q-four">?</span><span className="raffle-question q-five">?</span><span className="raffle-question q-six">?</span><span className="raffle-question q-seven">?</span>
                <img className="raffle-custom-box" src={mysteryBox} alt="" /></div>
            </div>
            <div className="raffle-orbit-pool">
                <ol ref={prizeArea} className="raffle-orbit-prizes">{pool.map((prize, index) => {
                    const winner = selected?.outcome === prize.outcome;
                    const { x, y } = positions[index];
                    return <li key={prize.outcome} className={`raffle-orbit-prize ${winner ? 'is-winning-prize' : ''}`} style={{ '--prize-x': `${x}%`, '--prize-y': `${y}%` }}>
                        <div className="raffle-prize-icon">{itemImageUrl(prize.image) ? <GiveawayItemImage source={itemImageUrl(prize.image)} refined /> : <span aria-hidden="true">?</span>}</div>
                        <div className="raffle-prize-description"><strong>{prize.name}</strong><span>x {quantity(prize.quantity)} <i aria-hidden="true">·</i> {(prize.probability_bps / 100).toFixed(1)}% chance</span>{winner && <span className="raffle-winning-label">✦ Winning prize</span>}</div>
                    </li>;
                })}</ol>
            </div>
            {selected && raffle.winner_player_id && <aside className="raffle-winner-details" aria-label="Raffle winner">
                <span className="raffle-winner-eyebrow">The lucky winner</span>
                <a href={winnerResult?.profile_id ? `/seller/${winnerResult.profile_id}` : `https://www.kingdomofloathing.com/showplayer.php?who=${raffle.winner_player_id}`}>{winnerResult?.winner_name || `Player #${raffle.winner_player_id}`}</a>
                {winnerResult?.winning_ticket && <><span className="raffle-winner-eyebrow">Winning ticket</span><strong className="raffle-winning-ticket">#{quantity(winnerResult.winning_ticket)}</strong></>}
            </aside>}
        </div>
        <footer className="raffle-showcase-footer">
            <span>{selected ? <><span className="raffle-footer-star" aria-hidden="true">✦</span> Winning prize: <strong>{quantity(selected.quantity)} × {selected.name}</strong></> : 'The raffle winner receives one of the above items based on the listed odds.'}</span>
            <time dateTime={raffle.ends_at}>{closed ? 'Closed' : 'Closes'} {new Date(raffle.ends_at).toLocaleString()}</time>
        </footer>
    </article>;
}
RafflePrizeDisplay.propTypes = { raffle: PropTypes.object.isRequired, marketPrices: PropTypes.instanceOf(Map), now: PropTypes.number, winnerResult: PropTypes.object };

export default function RaffleShowcase({ raffle, now }) {
    const key = JSON.stringify(raffle.prizes.map(p => p.item_id).sort((a, b) => a - b));
    const [records, setRecords] = useState(null);
    const [result, setResult] = useState(null);
    useEffect(() => {
        let active = true;
        if (raffle.id && raffle.selected_outcome && supabase) {
            supabase.rpc('read_raffle_result', { p_id: raffle.id }).then(({ data, error }) => {
                if (active && !error && data) setResult({ id: raffle.id, winner: raffle.winner_player_id, data });
            }).catch(() => {});
        }
        return () => { active = false; };
    }, [raffle.id, raffle.selected_outcome, raffle.winner_player_id]);
    useEffect(() => {
        let active = true;
        prices.load(JSON.parse(key)).then(data => { if (active) setRecords({ key, data }); });
        return () => { active = false; };
    }, [key]);
    return <RafflePrizeDisplay raffle={raffle} now={now} marketPrices={records?.key === key ? records.data : undefined} winnerResult={result?.id === raffle.id && result?.winner === raffle.winner_player_id ? result.data : null} />;
}
RaffleShowcase.propTypes = { raffle: PropTypes.object.isRequired, now: PropTypes.number };
