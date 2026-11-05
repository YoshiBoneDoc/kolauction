import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { readPublicRaffleCommitment } from '../lib/publicRaffleCommitment';
import { supabase } from '../lib/supabase';
import '../components/raffles.css';
export default function RaffleCommitment() {
    const { id } = useParams();
    const [result, setResult] = useState(null);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        setResult(null); setMessage('');
        (import.meta.env.VITE_SHARED_AUCTION_CACHE === 'true' ? readPublicRaffleCommitment(id).then(data => ({ data })) : supabase.rpc('read_public_raffle_commitment', { p_id: id })).then(({ data, error }) => {
            if (active) setResult({ id, data, error: !!error });
        }).catch(() => { if (active) setResult({ id, error: true }); });
        return () => { active = false; };
    }, [id]);
    async function copy(value) {
        try { await navigator.clipboard.writeText(value); setMessage('Copied.'); }
        catch { setMessage('Select and copy the record below.'); }
    }
    return <main className="raffle-page"><section className="raffle-summary">
        <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-semibold">Raffle commitment record</h1><Link to={`/raffle/${id}`} className="inline-flex min-h-9 items-center rounded border border-current px-3 text-xs hover:underline">← Back</Link></div>
        {!result || result.id !== id ? <p role="status">Loading commitment…</p> : result.error ? <p role="alert">Record unavailable. Refresh to retry.</p> : !result.data ? <p>No commitment has been published for this raffle. It may not have finalized ticket intake, or it may use the earlier draw method.</p> : <>
            <p>This is kHub’s preserved commitment record, available before and after the draw.</p>
            <dl className="space-y-3 text-xs"><div><dt>Commitment hash</dt><dd className="break-all font-mono">{result.data.commitmentHash}</dd></div>
                <div><dt>Recorded by kHub</dt><dd><time dateTime={result.data.committedAt}>{new Date(result.data.committedAt).toLocaleString()}</time></dd></div>
                <div><dt>Scheduled drand round</dt><dd>{result.data.round} · <time dateTime={result.data.beaconAvailableAt}>{new Date(result.data.beaconAvailableAt).toLocaleString()}</time></dd></div>
            </dl>
            <div className="my-3 flex gap-4"><button type="button" onClick={() => copy(result.data.commitmentHash)}>Copy hash</button><button type="button" onClick={() => copy(JSON.stringify(result.data, null, 2))}>Copy timestamped record</button></div>
            <details><summary>Record details</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(result.data, null, 2)}</pre></details>
        </>}
        {message && <p role="status">{message}</p>}
    </section></main>;
}
