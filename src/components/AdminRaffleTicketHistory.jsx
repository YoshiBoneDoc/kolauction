import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

const number = value => BigInt(value).toLocaleString('en-US');
export default function AdminRaffleTicketHistory({ raffleId, revision = 0 }) {
    const [offset, setOffset] = useState(0);
    const [result, setResult] = useState(null);
    useEffect(() => {
        let active = true;
        supabase.rpc('read_admin_raffle_ticket_history', { p_id: raffleId, p_offset: offset }).then(({ data, error }) => {
            if (active) setResult(previous => ({ offset, rows: error ? (previous?.offset === offset ? previous.rows : null) : data, error: !!error }));
        }).catch(() => { if (active) setResult(previous => ({ offset, rows: previous?.offset === offset ? previous.rows : null, error: true })); });
        return () => { active = false; };
    }, [raffleId, offset, revision]);
    const ready = result?.offset === offset;
    return <section className="raffle-summary mt-4" aria-label="All raffle ticket history">
        <div className="raffle-ticket-heading"><h2>Ticket History</h2></div>
        {!ready ? <p role="status">Loading ticket history…</p> : result.error && !result.rows ? <p role="alert">Ticket history unavailable. Refresh to retry.</p> : <>
            {result.error && <p role="alert">Could not refresh ticket history. Showing previously loaded purchases.</p>}
            {!result.rows.length && <p>No tickets bought yet.</p>}
            <ul className="raffle-ticket-history">{result.rows.map(row => <li key={row.receipt_id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{row.profile_id ? <Link to={`/seller/${row.profile_id}`}>{row.username}</Link> : <a href={`https://www.kingdomofloathing.com/showplayer.php?who=${row.player_id}`}>{row.username}</a>}</strong><span>{number(row.ticket_count)} {row.ticket_count === '1' ? 'ticket' : 'tickets'}</span></div>
                <p><time dateTime={row.received_at}>{new Date(row.received_at).toLocaleString()}</time> · {number(row.meat)} Meat</p>
            </li>)}</ul>
        </>}
        {(offset > 0 || (ready && result.rows?.length === 50)) && <div className="mt-3 flex items-center gap-4 text-xs"><button type="button" disabled={!offset} onClick={() => setOffset(value => value - 50)}>Previous</button><span>Page {offset / 50 + 1}</span><button type="button" disabled={!ready || result.error || result.rows?.length !== 50} onClick={() => setOffset(value => value + 50)}>Next</button></div>}
    </section>;
}
AdminRaffleTicketHistory.propTypes = { raffleId: PropTypes.string.isRequired, revision: PropTypes.number };
