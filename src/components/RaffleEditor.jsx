import MarketPrice from './MarketPrice';
import SpecialAuctionNavigation from './SpecialAuctionNavigation';
import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { normalizeAuctionAmount } from '../lib/auctionInputs';
import { validateRaffle, equalOdds, prizeOddsTotal, adjustPrizeOdds, rebalancePrizePool, nudgePrizeOdds } from '../lib/raffles';
import { localDateTimeInput } from '../lib/auctionSchedule';
import RaffleSummary from './RaffleSummary';

export default function RaffleEditor({ items, onExit, onGiveaway }) {
    const navigate = useNavigate();
    const [name, setName] = useState('Mystery Raffle');
    const [ticketPrice, setTicketPrice] = useState('1,000,000');
    const [endsAt, setEndsAt] = useState(() => localDateTimeInput(Date.now() + 7 * 86400000));
    const [search, setSearch] = useState('');
    const [prizes, setPrizes] = useState([]);
    const [customOdds, setCustomOdds] = useState(false);
    const total = prizeOddsTotal(prizes);
    const [editingOddsId, setEditingOddsId] = useState(null);
    const [oddsDraft, setOddsDraft] = useState(null);
    const [oddsInvalid, setOddsInvalid] = useState(false);
    function changePool(next) {
        try { setPrizes(customOdds ? rebalancePrizePool(prizes, next) : equalOdds(next)); setError(''); setOddsDraft(null); setOddsInvalid(false); }
        catch (e) { setError(e.message); }
    }
    function editOdds(id, value) {
        setOddsDraft({ id, value });
        try { setPrizes(adjustPrizeOdds(prizes, id, value)); setOddsInvalid(false); setError(''); }
        catch (e) { setOddsInvalid(true); setError(e.message); }
    }
    function nudgeOdds(id, direction) {
        try { setPrizes(nudgePrizeOdds(prizes, id, direction)); setOddsDraft(null); setOddsInvalid(false); setError(''); }
        catch (e) { setError(e.message); }
    }
    function resetOdds() { setPrizes(equalOdds(prizes)); setOddsDraft(null); setOddsInvalid(false); setError(''); }
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const requestId = useRef(crypto.randomUUID());
    const saving = useRef(false);
    function review(event) {
        event.preventDefault();
        if (oddsInvalid) { setError('Correct the win chance before previewing.'); return; }
        try { const validated = validateRaffle({ name, ticketPrice, endsAt, prizes }); setError(''); setPreview({ name: name.trim(), ticket_price: validated.ticketPrice, ends_at: validated.endsAt, prizes: prizes.map((p, i) => ({ ...p, probability_bps: validated.prizes[i].probability_bps })) }); }
        catch (e) { setError(e.message); }
    }
    async function save() {
        if (saving.current) return;
        saving.current = true; setBusy(true); setError('');
        try {
            const draft = validateRaffle({ name, ticketPrice, endsAt, prizes });
            const { data, error: failure } = await supabase.rpc('publish_mystery_raffle', { p_request_id: requestId.current, p_name: draft.name, p_ticket_price: draft.ticketPrice, p_ends_at: draft.endsAt, p_prizes: draft.prizes });
            if (failure) throw failure;
            navigate(`/raffle/${data}`);
        } catch { setError('Publishing was not confirmed. Check admin access and the raffle migrations, then retry.'); }
        finally { saving.current = false; setBusy(false); }
    }
    return <section className="raffle-editor" aria-label="Create raffle"><SpecialAuctionNavigation mode="raffle" onStandard={onExit} onGiveaway={onGiveaway} />{error && <p className="raffle-error" role="alert">{error}</p>}{preview ? <><RaffleSummary raffle={preview} /><div className="raffle-publish-actions"><button className="raffle-back-edit" disabled={busy} onClick={() => setPreview(null)}>Back to Edit</button><button className="raffle-publish-live" disabled={busy} onClick={save}>{busy ? 'Publishing…' : 'Publish Raffle Live'}</button></div></> : <form onSubmit={review}><div className="raffle-details-fields"><label>Raffle name<input maxLength={80} required value={name} onChange={e => setName(e.target.value)} /></label><div className="raffle-fields"><label><span>Ticket price: <small className="raffle-unit">(meat)</small></span><input type="text" inputMode="decimal" autoComplete="off" required value={ticketPrice} onChange={e => setTicketPrice(e.target.value)} onBlur={() => setTicketPrice(value => normalizeAuctionAmount(value, { meat: true }))} placeholder="e.g. 5k, 10m, 50b" /></label><label><span>Closing date/time:</span><input type="datetime-local" required value={endsAt} onChange={e => setEndsAt(e.target.value)} /></label></div></div><h3 className="mt-4 font-bold">Possible prizes</h3><p>Add up to 20 prize types. Each row counts as one possible prize, regardless of quantity.</p><label>Find an item<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search the item catalog…" /></label>{search.trim() && <ul className="max-h-48 overflow-y-auto">{items.filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 50).map(item => <li key={item.id}><button type="button" disabled={prizes.length >= 20 || prizes.some(p => p.id === item.id)} onClick={() => { changePool([...prizes, { ...item, quantity: '1', chance: '0' }]); setSearch(''); }}>+ {item.name}</button></li>)}</ul>}<div className="raffle-odds-controls"><label><input type="checkbox" checked={customOdds} onChange={e => { setCustomOdds(e.target.checked); if (!e.target.checked) resetOdds(); }} />Customize odds</label></div><p>Lock a prize to keep its odds fixed.</p>{prizes.length > 0 && <div className={`raffle-pool-head ${customOdds ? 'raffle-pool-custom' : ''}`} ><span>Qty</span><span>Item</span><span className="raffle-odds-heading"><span>Win Chance (%)</span>{customOdds && <button type="button" className="raffle-reset-odds" onClick={() => { resetOdds(); }}>Reset odds</button>}</span>{customOdds && <span />}<span /></div>}<ul className={`raffle-prizes raffle-pool ${customOdds ? 'raffle-pool-custom' : ''}`}>{prizes.map(item => <li key={item.id}><label className="raffle-quantity"><span className="sr-only">Quantity for {item.name}</span><input type="number" min="1" max="1000000000" step="1" required value={item.quantity} onChange={e => setPrizes(prizes.map(p => p.id === item.id ? { ...p, quantity: e.target.value } : p))} /></label><div className="raffle-prize-name min-w-0 flex-1">{item.name}<MarketPrice itemId={item.id} /></div><div className="raffle-chance"><span className="raffle-chance-control">{editingOddsId === item.id ? <input autoFocus onFocus={e => e.target.select()} type="number" inputMode="decimal" min="0" max="100" step="0.01" required disabled={!customOdds || item.locked} value={oddsDraft?.id === item.id ? oddsDraft.value : item.chance} onChange={e => editOdds(item.id, e.target.value)} onBlur={() => { setOddsDraft(null); setOddsInvalid(false); setEditingOddsId(null); }} aria-invalid={oddsDraft?.id === item.id && oddsInvalid} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudgeOdds(item.id, e.key === 'ArrowUp' ? 1 : -1); } }} aria-label={`Win Chance (%) for ${item.name}`} /> : <button type="button" className="raffle-chance-value" disabled={!customOdds || item.locked} aria-label={`Edit win chance for ${item.name}`} onClick={() => setEditingOddsId(item.id)} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudgeOdds(item.id, e.key === 'ArrowUp' ? 1 : -1); } }}>{item.chance}%</button>}{customOdds && <span className="raffle-chance-arrows">{[1, -1].map(direction => <button key={direction} type="button" disabled={!customOdds || item.locked} aria-label={`${direction === 1 ? 'Increase' : 'Decrease'} win chance for ${item.name}`} title={`Step: ${(Math.round(400 / prizes.length) / 100).toFixed(2)}%`} onClick={() => nudgeOdds(item.id, direction)}>{direction === 1 ? '▴' : '▾'}</button>)}</span>}</span></div>{customOdds && <button type="button" className="raffle-odds-lock" aria-label={`${item.locked ? 'Unlock' : 'Lock'} odds for ${item.name}`} aria-pressed={!!item.locked} title={item.locked ? 'Unlock odds' : 'Lock odds'} onClick={() => setPrizes(prizes.map(p => p.id === item.id ? { ...p, locked: !p.locked } : p))}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="5" y="10" width="14" height="11" rx="2" />{item.locked ? <path d="M8 10V6a4 4 0 0 1 8 0v4" /> : <path d="M8 10V6a4 4 0 0 1 8 0" />}</svg></button>}<button type="button" className="raffle-prize-remove" aria-label={`Remove ${item.name}`} onClick={() => changePool(prizes.filter(p => p.id !== item.id))}>×</button></li>)}</ul><div className="raffle-odds-footer"><p role="status" className={total === 10000 ? '' : 'raffle-error'}>Combined probability: {total === null ? 'Invalid' : `${(total / 100).toFixed(2)}%`}{total !== 10000 && ' · Must equal 100%.'}</p></div><button disabled={total !== 10000 || oddsInvalid} className="raffle-primary special-preview-button raffle-preview-button w-full" type="submit">Preview Raffle</button></form>}</section>;
}
RaffleEditor.propTypes = { items: PropTypes.array.isRequired, onExit: PropTypes.func.isRequired, onGiveaway: PropTypes.func.isRequired };
