import { canViewRaffles } from '../lib/raffleVisibility';
import RaffleManagement from '../components/RaffleManagement';
import { UserContext } from '../context/UserContext';
import { useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import RaffleSummary from '../components/RaffleSummary';

export default function Raffles() {
    const { currentUser } = useContext(UserContext);
    const { id } = useParams();
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState({ key: null });
    const [tickets, setTickets] = useState(null);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        let active = true;
        setTickets(null);
        if (!canViewRaffles(currentUser)) return;
        if (id && currentUser?.id) supabase.rpc('read_my_raffle_tickets', { p_id: id }).then(({ data, error }) => { if (active && !error) setTickets({ ...data, owner: currentUser.id, raffleId: id }); }).catch(() => {});
        async function load() {
            try {
                let query = supabase.from('mystery_raffles').select('id,name,ticket_price,ends_at,state,completion_reason,created_at,winner_player_id,selected_outcome,prizes:mystery_raffle_prizes(outcome,item_id,name,image,quantity,probability_bps)');
                query = id ? query.eq('id', id) : query.order('created_at', { ascending: false }).limit(20);
                const { data, error } = await query;
                if (error) throw error;
                if (active) setResult({ key: id ?? 'list', rows: data.map(r => ({ ...r, prizes: r.prizes.sort((a, b) => a.outcome - b.outcome) })) });
            } catch { if (active) setResult({ key: id ?? 'list', error: 'Raffles are unavailable.' }); }
        }
        load();
        return () => { active = false; };
    }, [id, currentUser, revision]);
    // Local display clock only; no polling or auction subscriptions.
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
    if (!canViewRaffles(currentUser)) return <main className="raffle-page"><p>Page unavailable.</p></main>;
    return <main className="raffle-page"><Link to="/auction-item">Create Auction</Link><h1 className="mb-4 text-2xl font-bold">Mystery Raffles</h1><button onClick={() => setRevision(v => v + 1)}>Refresh raffle</button><p className="mb-4 text-sm">Controlled live testing · active raffles use real Meat and items.</p>{result.key !== (id ?? 'list') ? <p role="status">Loading raffles…</p> : result.error ? <p role="alert">{result.error}</p> : <div className="raffle-list">{!result.rows.length && <p>No raffles found.</p>}{result.rows.map(raffle => <div key={raffle.id}>{!id && <Link className="mb-2 inline-block" to={`/raffle/${raffle.id}`}>View raffle ↗</Link>}<RaffleSummary raffle={raffle} now={now} />{raffle.completion_reason === 'cancelled' && <p>Raffle canceled. Ticket refunds are tracked in your purchase history.</p>}{raffle.completion_reason === 'no_tickets' && <p>Closed without valid tickets. Deposits are being returned.</p>}{raffle.state === 'active' && <p>To buy tickets, KMail kHub (#3888760) with RAFFLE {raffle.id} and an exact multiple of the ticket price in attached Meat. Payments must be processed before closing.</p>}{raffle.winner_player_id && <p>Winner: player #{raffle.winner_player_id} · Selected prize: {raffle.prizes.find(p => p.outcome === raffle.selected_outcome)?.name}. {raffle.state === 'settled' ? 'Settlement complete.' : 'Fulfillment in progress.'}</p>}</div>)}</div>}{id && currentUser?.id && tickets?.owner === currentUser.id && tickets?.raffleId === id && <section className="mt-4"><h2>Your tickets: {tickets.ticket_count}</h2><p>Each ticket is equally weighted. A cryptographically random ticket selects the winner; a separate random draw selects one prize using its listed probability. Ticket totals and other players’ purchases are private.</p><ul>{tickets.purchases.map(p => <li key={p.receipt_id}>Tickets {p.first_ticket}–{p.last_ticket} · {p.meat} Meat · {new Date(p.received_at).toLocaleString()}{p.refund_status && ` · ${p.refund_status === 'refunded' ? 'Refund verified' : 'Refund awaiting verification'}`}</li>)}</ul></section>}{id && currentUser?.isAdmin && <RaffleManagement key={`${id}:${currentUser.id}`} raffleId={id} ownerId={currentUser.id} onChange={() => setRevision(v => v + 1)} />}</main>;
}
