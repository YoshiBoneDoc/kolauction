import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

const number = value => BigInt(value ?? 0).toLocaleString('en-US');
const meat = value => value == null ? 'Unavailable' : `${number(value)} Meat`;
const panel = 'rounded-lg border border-gray-100 bg-gray-50 px-4 py-3';
const link = 'text-blue-700 underline';
function Player({ row }) {
    return row.profile_id ? <Link className={link} to={`/seller/${row.profile_id}`}>{row.username}</Link> : <a className={link} href={`https://www.kingdomofloathing.com/showplayer.php?who=${row.player_id}`}>{row.username}</a>;
}
Player.propTypes = { row: PropTypes.object.isRequired };
function Participants({ raffleId }) {
    const [rows, setRows] = useState([]);
    const [offset, setOffset] = useState(0);
    const [error, setError] = useState('');
    const [more, setMore] = useState(false);
    useEffect(() => {
        let active = true;
        supabase.rpc('read_admin_raffle_participants', { p_id: raffleId, p_offset: offset }).then(({ data, error: failure }) => {
            if (!active) return;
            if (failure) setError('Participant data unavailable.');
            else { setRows(data); setMore(data.length === 50); setError(''); }
        }).catch(() => { if (active) setError('Participant data unavailable.'); });
        return () => { active = false; };
    }, [raffleId, offset]);
    return <>{error ? <p role="alert">{error}</p> : <ul className="mt-2 space-y-1">{rows.map(row => <li key={row.player_id}><Player row={row} /> · {number(row.tickets)} tickets</li>)}</ul>}<Pager offset={offset} setOffset={setOffset} more={more} /></>;
}
Participants.propTypes = { raffleId: PropTypes.string.isRequired };
function Pager({ offset, setOffset, more }) {
    return (offset > 0 || more) && <div className="mt-2 flex gap-4"><button disabled={!offset} onClick={() => setOffset(offset - 50)}>Previous</button><span>Page {offset / 50 + 1}</span><button disabled={!more} onClick={() => setOffset(offset + 50)}>Next</button></div>;
}
Pager.propTypes = { offset: PropTypes.number.isRequired, setOffset: PropTypes.func.isRequired, more: PropTypes.bool.isRequired };
export default function AdminRaffleAnalytics() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [offset, setOffset] = useState(0);
    const [open, setOpen] = useState({});
    useEffect(() => {
        let active = true;
        setError('');
        supabase.rpc('read_admin_raffle_analytics', { p_offset: offset }).then(({ data: value, error: failure }) => {
            if (!active) return;
            if (failure || !value) setError(failure?.code === '42501' ? 'Administrator access required.' : 'Raffle analytics unavailable. Apply migration 203, then refresh.');
            else setData(value);
        }).catch(() => { if (active) setError('Raffle analytics unavailable. Please refresh.'); });
        return () => { active = false; };
    }, [offset]);
    if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
    if (!data) return <p role="status" className="text-sm text-gray-500">Loading raffle analytics…</p>;
    return <div className="space-y-4 text-sm text-gray-700">
        <section aria-label="Current raffle" className={panel}>
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Current Raffle</h2>
            {!data.current.length && <p>No current raffles.</p>}
            {data.current.map(r => <div key={r.id} className="border-t border-gray-200 py-2 first:border-0">
                <div className="flex flex-wrap justify-between gap-2"><Link className={link} to={`/raffle/${r.id}`}>{r.name}</Link><span className="capitalize">{r.status}</span></div>
                <p className="my-1 tabular-nums">{number(r.tickets)} tickets · {meat(r.revenue)}</p>
                <p className="text-xs">{r.prize_name ? `Winning prize: ${number(r.prize_quantity)} × ${r.prize_name}` : new Date(r.ends_at) <= new Date() && r.state !== 'preview' ? 'Closed · winning prize pending drawing' : `Prize pool: ${r.pool.map(p => `${number(p.quantity)} × ${p.name}`).join(' · ')}`}</p>
                <details className="mt-2 text-xs" open={!!open[r.id]} onToggle={e => { const value = e.currentTarget.open; setOpen(previous => previous[r.id] === value ? previous : { ...previous, [r.id]: value }); }}><summary className="cursor-pointer">Participants</summary>{open[r.id] && <Participants raffleId={r.id} />}</details>
            </div>)}
            {data.current.length === 50 && <p className="text-xs">Showing the latest 50 current raffles.</p>}
        </section>
        <section aria-label="Lifetime raffle statistics">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Lifetime Raffle Statistics</h2>
            <div className="grid gap-3 sm:grid-cols-3">{[
                ['Total Revenue', meat(data.revenue)], ['Total Tickets', number(data.tickets)],
                ['Total Prize Value', meat(data.prize_value)], ['Estimated Profit', meat(data.profit)],
            ].map(([label, value]) => <div className={panel} key={label}><h3 className="text-xs font-medium text-gray-600">{label}</h3><p className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{value}</p></div>)}
                <details className={panel}><summary className="cursor-pointer text-xs font-medium text-gray-600">Unique Participants <span className="mt-1 block text-lg font-semibold text-gray-900">{number(data.participants)}</span></summary>
                    <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Username</th><th>Raffles</th><th>Tickets</th></tr></thead><tbody>{data.people.map(row => <tr key={row.player_id}><td className="py-2"><Player row={row} /></td><td>{number(row.raffles)}</td><td>{number(row.tickets)}</td></tr>)}</tbody></table></div>
                    <Pager offset={offset} setOffset={setOffset} more={data.people.length === 50} />
                </details>
            </div>
            <p className="mt-2 text-xs text-gray-500">Gross accepted ticket sales; includes {meat(data.refundable_revenue)} from canceled raffles (refunded or refundable). Rejected payments, deposits, advances and payouts are not sales. Participation includes canceled purchases. Prize value counts delivered winning prizes only. Profit counts concluded draws with known closing valuations, excluding canceled raffles; {number(data.unavailable)} unavailable valuations excluded, including their revenue. Values are approximate Mall snapshots, not acquisition costs.</p>
        </section>
        <details className={panel}><summary className="cursor-pointer font-semibold">Past Raffle Results</summary>
            <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs tabular-nums"><thead><tr>{['Raffle', 'Winning prize', 'Value at closing', 'Ticket revenue', 'Estimated profit'].map(label => <th className="px-2 py-2" key={label}>{label}</th>)}</tr></thead><tbody>{data.past.map(r => <tr key={r.id} className="border-t border-gray-200"><td className="px-2 py-2"><Link className={link} to={`/raffle/${r.id}`}>{r.name}</Link><span className="block capitalize">{(r.completion_reason || r.state).replaceAll('_', ' ')}</span></td><td className="px-2 py-2">{r.prize_name ? `${number(r.prize_quantity)} × ${r.prize_name}` : 'No winning prize'}</td><td className="px-2 py-2">{meat(r.value)}</td><td className="px-2 py-2">{meat(r.revenue)}</td><td className="px-2 py-2">{meat(r.profit)}</td></tr>)}</tbody></table>{!data.past.length && <p>No results on this page.</p>}</div>
            <Pager offset={offset} setOffset={setOffset} more={data.past.length === 50} />
        </details>
    </div>;
}
