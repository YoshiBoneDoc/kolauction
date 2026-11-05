import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import GiveawayItemImage from './GiveawayItemImage';
import { itemImageUrl } from '../lib/itemCatalog';
import { raffleCountdown } from '../lib/raffles';
import { createMarketPriceService } from '../lib/marketPrices';
import { supabase } from '../lib/supabase';
import mysteryBox from '../assets/raffle-mystery-box.svg';
import { rafflePrizePositions, raffleBoxCenter } from '../lib/rafflePrizeCurve';
import './raffles.css';

const prices = createMarketPriceService(supabase);
const quantity = value => BigInt(value).toLocaleString('en-US');

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
        <div className="raffle-facts"><strong>{quantity(raffle.ticket_price)} Meat <small>/ ticket</small></strong>{!closed && <span>{raffleCountdown(raffle.ends_at, now)}</span>}</div></div>
            <span className={`raffle-showcase-status ${concluded ? 'is-concluded' : ''}`}>{status}</span>
        </header>
        <h3 className="raffle-pool-heading" style={{ '--first-prize-offset': `${(positions[0]?.x ?? 5) * areaSize.width / 100}px` }}>Possible prizes</h3>
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
                        <div className="raffle-prize-icon">{itemImageUrl(prize.image) ? <GiveawayItemImage source={itemImageUrl(prize.image)} /> : <span aria-hidden="true">?</span>}</div>
                        <div className="raffle-prize-description"><strong>{prize.name}</strong><span>Qty {quantity(prize.quantity)} <i aria-hidden="true">·</i> {(prize.probability_bps / 100).toFixed(2)}% chance</span>{winner && <span className="raffle-winning-label">✦ Winning prize</span>}</div>
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
            <span>{selected ? <><span className="raffle-footer-star" aria-hidden="true">✦</span> Winning prize: <strong>{quantity(selected.quantity)} × {selected.name}</strong></> : 'One winning ticket. One mystery prize.'}</span>
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
