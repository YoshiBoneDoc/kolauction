import CopyMessage from '../components/CopyMessage';
import { canViewRaffles } from '../lib/raffleVisibility';
import RaffleManagement from '../components/RaffleManagement';
import { UserContext } from '../context/UserContext';
import { useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import RaffleShowcase from '../components/RaffleShowcase';

export default function Raffles() {
    const { currentUser } = useContext(UserContext);
    const { id } = useParams();
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState({ key: null });
    const [tickets, setTickets] = useState(null);
    const [counts, setCounts] = useState(null);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        let active = true;
        setTickets(null);
        setCounts(null);
        if (!canViewRaffles(currentUser)) return;
        if (id && currentUser?.id) supabase.rpc('read_my_raffle_tickets', { p_id: id }).then(({ data, error }) => { if (active && !error) setTickets({ ...data, owner: currentUser.id, raffleId: id }); }).catch(() => {});
        async function load() {
            try {
                let query = supabase.from('mystery_raffles').select('id,raffle_number,name,ticket_price,ends_at,state,completion_reason,created_at,winner_player_id,selected_outcome,prizes:mystery_raffle_prizes(outcome,item_id,name,image,quantity,probability_bps)');
                query = id ? query.eq('id', id) : query.order('created_at', { ascending: false }).limit(20);
                const { data, error } = await query;
                if (error) throw error;
                if (active) setResult({ key: id ?? 'list', rows: data.map(r => ({ ...r, prizes: r.prizes.sort((a, b) => a.outcome - b.outcome) })) });
                if (!id && data.length && currentUser?.id) {
                    const response = await supabase.rpc('read_my_raffle_counts', { p_ids: data.map(r => r.id) });
                    if (active && !response.error) setCounts({ owner: currentUser.id, data: response.data });
                }
            } catch { if (active) setResult({ key: id ?? 'list', error: 'Raffles are unavailable.' }); }
        }
        load();
        return () => { active = false; };
    }, [id, currentUser, revision]);
    // Local display clock only; no polling or auction subscriptions.
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
    if (!canViewRaffles(currentUser)) return <main className="raffle-page"><p>Page unavailable.</p></main>;
    return <main className="raffle-page"><h1 className="mb-4 text-2xl font-bold">Mystery Raffles</h1>{result.key !== (id ?? 'list') ? <p role="status">Loading raffles…</p> : result.error ? <p role="alert">{result.error}</p> : <div className="raffle-list">{!result.rows.length && <p>No raffles found.</p>}{result.rows.map(raffle => <div key={raffle.id}>{!id && <Link className="mb-2 inline-block" to={`/raffle/${raffle.id}`}>View raffle ↗</Link>}<RaffleShowcase raffle={raffle} now={now} />{raffle.completion_reason === 'cancelled' && <p>Raffle canceled. Ticket refunds are tracked in your purchase history.</p>}{raffle.completion_reason === 'no_tickets' && <p>Closed without valid tickets. Deposits are being returned.</p>}{['preview', 'active'].includes(raffle.state) && <section className="raffle-summary mt-4" aria-label="How to buy raffle tickets">
                    <div className="raffle-ticket-heading"><h2>Buy Raffle Tickets</h2>{currentUser?.id && <span className="raffle-user-ticket-count">Your tickets <strong>{tickets?.owner === currentUser.id && tickets?.raffleId === raffle.id ? BigInt(tickets.ticket_count).toLocaleString('en-US') : counts?.owner === currentUser.id ? BigInt(counts.data?.[raffle.id] ?? '0').toLocaleString('en-US') : '…'}</strong></span>}</div>
                    {raffle.state === 'preview' && <p>This raffle is a draft. Wait until it is active before sending payment.</p>}
                    <p>Send a KMail to <strong>kHub (#3888760)</strong> with this command in the message:</p>
                    <CopyMessage text={`RAFFLE ${raffle.raffle_number}`} label="raffle ticket command" compact className="my-2 text-sm" />
                    <p>Attach <strong>{BigInt(raffle.ticket_price).toLocaleString('en-US')} Meat per ticket</strong> (e.g., {(BigInt(raffle.ticket_price) * 5n).toLocaleString('en-US')} Meat for 5 tickets). Send Meat only, no items.</p>
                    <p className="raffle-ticket-chances">Each ticket has an equal chance of winning, and you may buy more anytime before closing.</p>
                    <p className="raffle-ticket-processing">Tickets are confirmed when payment is processed. <em>Payments containing items, non-exact ticket amounts, or those received at or after closing are automatically refunded.</em></p>
                </section>}</div>)}</div>}{id && currentUser?.id && tickets?.owner === currentUser.id && tickets?.raffleId === id && tickets.purchases.length > 0 && <section className="raffle-summary mt-4" aria-label="Your ticket history"><div className="raffle-ticket-heading"><h2>Ticket History</h2>{result.rows?.some(raffle => raffle.id === id && !['preview', 'active'].includes(raffle.state)) && <span className="raffle-user-ticket-count">Your tickets <strong>{BigInt(tickets.ticket_count).toLocaleString('en-US')}</strong></span>}</div><ul className="raffle-ticket-history">{tickets.purchases.map(p => <li key={p.receipt_id}><div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{(BigInt(p.last_ticket) - BigInt(p.first_ticket) + 1n).toLocaleString('en-US')} {BigInt(p.last_ticket) === BigInt(p.first_ticket) ? 'ticket' : 'tickets'}</strong><span>{BigInt(p.meat).toLocaleString('en-US')} Meat</span></div><p>{BigInt(p.first_ticket) === BigInt(p.last_ticket) ? `Ticket ${BigInt(p.first_ticket).toLocaleString('en-US')}` : `Tickets ${BigInt(p.first_ticket).toLocaleString('en-US')}–${BigInt(p.last_ticket).toLocaleString('en-US')}`} · <time dateTime={p.received_at}>{new Date(p.received_at).toLocaleString()}</time>{p.refund_status && ` · ${p.refund_status === 'refunded' ? 'Refund verified' : 'Refund awaiting verification'}`}</p></li>)}</ul></section>}{id && currentUser?.isAdmin && <RaffleManagement key={`${id}:${currentUser.id}`} raffleId={id} ownerId={currentUser.id} onChange={() => setRevision(v => v + 1)} />}</main>;
}
