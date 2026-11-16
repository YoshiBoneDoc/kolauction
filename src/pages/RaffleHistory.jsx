import { useContext, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { canViewRaffles } from '../lib/raffleVisibility';
import { supabase } from '../lib/supabase';
import { readRaffle } from '../lib/raffleService';
import NotFound from './NotFound';
import { loadPreviousRaffles } from '../lib/previousRaffles';
import '../components/raffles.css';

export default function RaffleHistory() {
    const { currentUser } = useContext(UserContext);
    const [params, setParams] = useSearchParams();
    const requestedPage = Number(params.get('page') || 1);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const access = canViewRaffles(currentUser);
    const owner = currentUser?.id;
    const [attempt, setAttempt] = useState(0);
    const [loaded, setLoaded] = useState(null);
    const result = loaded?.owner === owner && loaded?.page === page && loaded?.attempt === attempt ? loaded : null;
    useEffect(() => {
        if (!access) return;
        let active = true;
        async function load() {
            try {
                const { rows, hasNext } = await loadPreviousRaffles(supabase, readRaffle, page, attempt > 0);
                if (active) setLoaded({ owner, page, attempt, rows, hasNext });
            } catch {
                if (active) setLoaded({ owner, page, attempt, error: true });
            }
        }
        load();
        return () => { active = false; };
    }, [access, owner, page, attempt]);
    if (!access) return <NotFound />;
    return <main className="raffle-page">
        <h1 className="mb-2 text-2xl font-bold">Previous Raffles &amp; Winners</h1>
        <Link to="/raffles" className="mb-4 inline-block text-blue-700 underline dark:text-blue-300">Back to raffles</Link>
        {!result ? <p role="status">Loading previous raffles…</p> : result.error ? <p role="alert">Previous raffles are unavailable. <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : <>
            {!result.rows.length && <p>No previous raffles found.</p>}
            <ul className="raffle-ticket-history">{result.rows.map(row => {
                const prize = row.prizes?.find(item => item.outcome === row.selected_outcome);
                const canceled = row.state === 'cancelled' || row.completion_reason === 'cancelled';
                const empty = row.state === 'empty' || row.completion_reason === 'no_tickets';
                return <li key={row.id}>
                    <Link className="font-semibold text-blue-700 underline dark:text-blue-300" to={`/raffle/${row.id}`}>{row.name} #{row.raffle_number}</Link>
                    <p><time dateTime={row.ends_at}>{new Date(row.ends_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time></p>
                    <p>{canceled ? 'Canceled · No winner' : empty ? 'Closed without tickets · No winner' : <>Winner: {row.winner?.winner_name || (row.winner_player_id ? `Player #${row.winner_player_id}` : 'Draw pending')}{prize && <> · Prize: {prize.quantity} × {prize.name}</>}</>}</p>
                </li>;
            })}</ul>
            <nav aria-label="Previous raffle pages" className="mt-4 flex items-center gap-4">
                <button disabled={page === 1} onClick={() => setParams({ page: String(page - 1) })}>Previous</button>
                <span>Page {page}</span>
                <button disabled={!result.hasNext} onClick={() => setParams({ page: String(page + 1) })}>Next</button>
            </nav>
        </>}
    </main>;
}
