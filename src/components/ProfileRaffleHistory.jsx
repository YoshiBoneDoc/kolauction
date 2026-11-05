import { raffleHistoryStatus } from '../lib/raffleHistory';
import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { readRaffle } from '../lib/raffleService';
import { supabase } from '../lib/supabase';
import { useNow } from '../hooks/useNow';
import ProfileTimeLeft from './ProfileTimeLeft';

export default function ProfileRaffleHistory({ userId }) {
    const [offset, setOffset] = useState(0);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState(null);
    const now = useNow();
    useEffect(() => {
        let active = true;
        setResult(null);
        readRaffle(`profile-history:${offset}`, () => supabase.rpc('read_my_raffle_history', { p_offset: offset })).then(({ data, error }) => {
            if (active) setResult(error ? { error: true } : { rows: data || [] });
        }).catch(() => { if (active) setResult({ error: true }); });
        return () => { active = false; };
    }, [userId, offset, attempt]);
    return <section className="profile-transaction-section profile-transaction-embedded">
        <h2 className="sr-only">Raffle History</h2>
        {!result ? <p role="status" className="profile-label py-3">Loading raffle history…</p> : result.error ? <p role="alert" className="profile-label py-3">Raffle history unavailable. <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : <>
            {!result.rows.length && <p className="profile-label py-3">No raffle participation yet.</p>}
            <div className="space-y-[5px]">{result.rows.map(row => <article key={row.id} className="profile-transaction-entry profile-history-entry">
                <div className="profile-entry-row"><Link className="profile-text text-[13px] font-semibold hover:underline" to={`/raffle/${row.id}`}>{row.name} #{row.raffle_number}</Link><span className="profile-entry-status">{raffleHistoryStatus(row, now) === 'Active' ? <ProfileTimeLeft endTime={Date.parse(row.ends_at)} /> : raffleHistoryStatus(row, now)}</span></div>
                <div className="profile-entry-row text-xs profile-label"><span>{BigInt(row.tickets).toLocaleString('en-US')} tickets purchased</span><span>{BigInt(row.ticket_price).toLocaleString('en-US')} Meat / ticket</span></div>
            </article>)}</div>
            {(offset > 0 || result.rows.length === 50) && <nav aria-label="Raffle history pages" className="mt-3 flex justify-between"><button disabled={!offset} onClick={() => setOffset(offset - 50)}>Previous</button><span>Page {offset / 50 + 1}</span><button disabled={result.rows.length < 50} onClick={() => setOffset(offset + 50)}>Next</button></nav>}
        </>}
    </section>;
}
ProfileRaffleHistory.propTypes = { userId: PropTypes.string.isRequired };
