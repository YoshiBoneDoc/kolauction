import RaffleFairness from '../components/RaffleFairness';
import CopyMessage from '../components/CopyMessage';
import { canViewRaffles } from '../lib/raffleVisibility';
import AdminRaffleTicketHistory from '../components/AdminRaffleTicketHistory';
import RaffleManagement from '../components/RaffleManagement';
import { UserContext } from '../context/UserContext';
import { useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { readRaffle } from '../lib/raffleService';
import RaffleShowcase from '../components/RaffleShowcase';
import NotFound from './NotFound';

export default function Raffles() {
    const { currentUser } = useContext(UserContext);
    const { id } = useParams();
    const viewerId = currentUser?.id;
    const raffleAccess = canViewRaffles(currentUser);
    const [revision, setRevision] = useState(0);
    const [loadedResult, setResult] = useState({ key: null });
    const result = loadedResult.owner === viewerId ? loadedResult : { key: null };
    const [tickets, setTickets] = useState(null);
    const [ticketError, setTicketError] = useState(null);
    const [history, setHistory] = useState({ id, offset: 0 });
    const offset = history.id === id ? history.offset : 0;
    const [counts, setCounts] = useState(null);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        let active = true;
        // Keep same-viewer data visible during refresh; render guards below
        // already reject ticket/history data belonging to another viewer/raffle.
        if (!raffleAccess) return;
        setTicketError(null);
        if (id && viewerId) readRaffle(`tickets:${id}:${offset}`, () => supabase.rpc('read_my_raffle_ticket_page', { p_id: id, p_offset: offset }), { force: revision > 0 }).then(({ data, error }) => { if (active && !error) setTickets({ ...data, owner: viewerId, raffleId: id, offset }); }).catch(() => { if (active) setTicketError({ id, viewerId }); });
        async function load() {
            try {
                let query = supabase.from('mystery_raffles').select('id,creator_id,prize_range_min,prize_range_max,prize_range_frozen_at,raffle_number,name,ticket_price,ends_at,state,completion_reason,created_at,winner_player_id,selected_outcome,prizes:mystery_raffle_prizes(outcome,item_id,name,image,quantity,probability_bps)');
                query = id ? query.eq('id', id) : query.eq('is_test', false).order('created_at', { ascending: false }).limit(20);
                const { data, error } = await readRaffle(`raffles:${id || "list"}`, () => query, { force: revision > 0 });
                if (error) throw error;
                if (active) setResult({ owner: viewerId, key: id ?? 'list', rows: data.map(r => ({ ...r, prizes: r.prizes.sort((a, b) => a.outcome - b.outcome) })) });
                if (!id && data.length && viewerId) {
                    const response = await readRaffle(`counts:${data.map(r => r.id).sort().join(',')}`, () => supabase.rpc('read_my_raffle_counts', { p_ids: data.map(r => r.id) }), { force: revision > 0 });
                    if (active && !response.error) setCounts({ owner: viewerId, data: response.data });
                }
            } catch { if (active) setResult(previous => ({ ...(previous.owner === viewerId && previous.key === (id ?? 'list') ? previous : {}), owner: viewerId, key: id ?? 'list', error: 'Raffles are unavailable. Refresh to retry.' })); }
        }
        load();
        return () => { active = false; };
    }, [id, viewerId, raffleAccess, revision, offset]);
    // Local display clock only; no polling or auction subscriptions.
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    if (!raffleAccess) return <NotFound />;
    return <main className="raffle-page">{ticketError?.id === id && ticketError?.viewerId === viewerId && <p role="alert">Ticket history unavailable. <button onClick={() => setRevision(v => v + 1)}>Retry</button></p>}<h1 className="mb-4 text-2xl font-bold">Mystery Raffles</h1>{result.key !== (id ?? 'list') ? <p role="status">Loading raffles…</p> : result.error && !result.rows ? <p role="alert">{result.error}</p> : <div className="raffle-list">{result.error && <p role="alert">{result.error}</p>}{!result.rows.length && <p>No raffles found.</p>}{result.rows.map(raffle => <div key={raffle.id}>{!id && <Link className="mb-2 inline-block" to={`/raffle/${raffle.id}`}>View raffle ↗</Link>}<RaffleShowcase raffle={raffle} now={now} />{raffle.completion_reason === 'cancelled' && <p>Raffle canceled. Ticket refunds are tracked in your purchase history.</p>}{raffle.completion_reason === 'no_tickets' && <p>Closed without valid tickets. Deposits are being returned.</p>}{!currentUser?.isAdmin && raffle.creator_id !== currentUser?.id && ['preview', 'active'].includes(raffle.state) && <section className="raffle-summary mt-4" aria-label="How to buy raffle tickets">
                    <div className="raffle-ticket-heading"><h2>Buy Raffle Tickets</h2>{currentUser?.id && <span className="raffle-user-ticket-count">Your tickets <strong>{tickets?.owner === currentUser.id && tickets?.raffleId === raffle.id ? BigInt(tickets.ticket_count).toLocaleString('en-US') : counts?.owner === currentUser.id ? BigInt(counts.data?.[raffle.id] ?? '0').toLocaleString('en-US') : '…'}</strong></span>}</div>
                    {raffle.state === 'preview' && <p>This raffle is a draft. Wait until it is active before sending payment.</p>}
                    <p>Send a KMail to <strong>kHub (#3888760)</strong> with this command in the message:</p>
                    <CopyMessage text={`RAFFLE ${raffle.raffle_number}`} label="raffle ticket command" compact className="my-2 text-sm" />
                    <p>Attach <strong>{BigInt(raffle.ticket_price).toLocaleString('en-US')} Meat per ticket</strong> (e.g., {(BigInt(raffle.ticket_price) * 5n).toLocaleString('en-US')} Meat for 5 tickets). Send Meat only, no items.</p>
                    <p className="raffle-ticket-chances">Each ticket has an equal chance of winning, and you may buy more anytime before closing.</p>
                    <p className="raffle-ticket-processing">Tickets are confirmed when payment is processed. <em>Payments containing items, non-exact ticket amounts, or those received at or after closing are automatically refunded.</em></p>
                </section>}</div>)}</div>}{id && currentUser?.isAdmin && <AdminRaffleTicketHistory key={`tickets:${id}:${currentUser.id}`} raffleId={id} revision={revision} />}{id && !currentUser?.isAdmin && currentUser?.id && tickets?.owner === currentUser.id && tickets?.raffleId === id && tickets.offset === offset && tickets.purchases.length > 0 && <section className="raffle-summary mt-4" aria-label="Your ticket history"><div className="raffle-ticket-heading"><h2>Ticket History</h2>{result.rows?.some(raffle => raffle.id === id && !['preview', 'active'].includes(raffle.state)) && <span className="raffle-user-ticket-count">Your tickets <strong>{BigInt(tickets.ticket_count).toLocaleString('en-US')}</strong></span>}</div><ul className="raffle-ticket-history">{tickets.purchases.map(p => <li key={p.receipt_id}><div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{(BigInt(p.last_ticket) - BigInt(p.first_ticket) + 1n).toLocaleString('en-US')} {BigInt(p.last_ticket) === BigInt(p.first_ticket) ? 'ticket' : 'tickets'}</strong><span>{BigInt(p.meat).toLocaleString('en-US')} Meat</span></div><p>{BigInt(p.first_ticket) === BigInt(p.last_ticket) ? `Ticket ${BigInt(p.first_ticket).toLocaleString('en-US')}` : `Tickets ${BigInt(p.first_ticket).toLocaleString('en-US')}–${BigInt(p.last_ticket).toLocaleString('en-US')}`} · <time dateTime={p.received_at}>{new Date(p.received_at).toLocaleString()}</time>{p.refund_status && ` · ${p.refund_status === 'refunded' ? 'Refund verified' : 'Refund awaiting verification'}`}</p></li>)}</ul><nav aria-label="Ticket history pages" className="flex gap-4 mt-3"><button disabled={!offset} onClick={() => setHistory({ id, offset: Math.max(0, offset - 50) })}>Previous</button><button disabled={offset + 50 >= tickets.purchase_count} onClick={() => setHistory({ id, offset: offset + 50 })}>Next</button></nav></section>}{id && viewerId && <RaffleFairness key={`proof:${id}:${viewerId}`} raffleId={id} viewerId={viewerId} revision={revision} endsAt={result.rows?.find(row => row.id === id)?.ends_at} />}{id && currentUser?.isAdmin && <RaffleManagement key={`management:${id}:${currentUser.id}`} raffleId={id} ownerId={currentUser.id} onChange={() => { readRaffle.invalidate(); setRevision(v => v + 1); }} />}</main>;
}
