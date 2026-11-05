import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';

export default function RaffleFairness({ raffleId, viewerId, revision }) {
    const dialogRef = useRef(null);
    const [attempt, setAttempt] = useState(0);
    const [summary, setSummary] = useState(null);
    const [proof, setProof] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [savedHash, setSavedHash] = useState('');
    useEffect(() => {
        if (open && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    }, [open]);
    useEffect(() => {
        let active = true;
        supabase.rpc('read_raffle_fairness_summary', { p_id: raffleId }).then(({ data, error }) => {
            if (active) setSummary(error ? { error: true } : data);
        }).catch(() => { if (active) setSummary({ error: true }); });
        return () => { active = false; };
    }, [raffleId, viewerId, revision, attempt]);
    async function showDetails() {
        setOpen(true); setBusy(true); setMessage('');
        try {
            const { data, error } = await supabase.rpc('read_raffle_fairness_proof', { p_id: raffleId });
            if (error || !data) throw new Error();
            setProof(data);
        } catch { setMessage('Proof unavailable. Please close and try again.'); }
        finally { setBusy(false); }
    }
    async function copy(value) {
        try { await navigator.clipboard.writeText(value); setMessage('Copied.'); }
        catch { setMessage('Copy unavailable. Select the values below and copy them manually.'); }
    }
    async function verify() {
        setBusy(true); setMessage('Checking commitment, beacon signature, winning ticket and prize…');
        try {
            const { verifyRaffleProof } = await import('../lib/raffleProof');
            const result = await verifyRaffleProof(proof, savedHash.trim());
            setMessage(`Verified: winning ticket #${result.winningTicket}, prize outcome ${result.selectedOutcome}. Both calculations match the signed beacon and commitment.`);
        } catch (error) { setMessage(`Verification failed: ${error.message}`); }
        finally { setBusy(false); }
    }
    return <section className="raffle-summary raffle-fairness mt-4" aria-label="Raffle fairness">
        <div className="flex items-center justify-between gap-3"><h2>Fairness proof</h2><button type="button" onClick={() => setAttempt(value => value + 1)}>Refresh proof</button></div>
        {summary?.error ? <p role="alert">Fairness information unavailable. Refresh to retry.</p> : !summary ? <p>No draw proof is available yet.</p> : ['cancelled', 'empty'].includes(summary.state) ? <p>No draw took place. There is no winner or prize selection to verify.</p> : !summary.required ? <p>This raffle uses the earlier draw method. No public-beacon proof exists for it.</p> : <>
            <p>Both the winning ticket and prize are selected using a signed public randomness beacon and fixed calculations.</p>
            {!summary.commitmentHash ? <p>The input commitment will be published after ticket intake closes, before the selected beacon round.</p> : <>
                <p>{summary.complete ? 'The draw is ready to verify.' : 'Inputs are committed. Waiting for verified public randomness. If gateways are delayed or unavailable, the bot automatically retries the same committed round; no replacement draw is used.'}</p>
                {!summary.complete && <button type="button" onClick={() => copy(JSON.stringify(summary, null, 2))}>Copy commitment before drawing</button>}
                <button type="button" onClick={showDetails} className="ml-3 underline">Verification details</button>
            </>}
        </>}
        {open && <div className="raffle-proof-overlay"><dialog ref={dialogRef} onCancel={() => { setOpen(false); setMessage(''); }} aria-modal="true" aria-labelledby="raffle-proof-title" className="raffle-proof-dialog">
            <div className="flex items-center justify-between gap-4"><h2 id="raffle-proof-title">Verify the draw</h2><button type="button" onClick={() => { setOpen(false); setMessage(''); }}>Close</button></div>
            <p>These technical details include the final ticket total. They contain no other players’ identities or individual ticket holdings. The total and ticket price also make gross ticket sales calculable.</p>
            <ol className="list-decimal space-y-2 pl-5">
                <li>Compare the commitment hash with one saved before the beacon was released. Without an earlier saved copy, verification checks the supplied commitment; it cannot prove when the operator published it.</li>
                <li>SHA-256 the exact UTF-8 manifest (no extra newline). It must equal the commitment hash. The manifest fixes the raffle, beacon round, ticket total, label offset, private-input hash and ordered prize odds.</li>
                <li>Verify the quicknet beacon signature against the pinned chain key. Its randomness must be SHA-256 of the decoded signature.</li>
                <li>Derive the seed and the separate ticket/prize hash streams. Rejection sampling selects one equally weighted ticket and one independently weighted prize.</li>
                <li>Compare the resulting ticket label with your confirmed ticket ranges and the announced winning ticket. Player-to-ticket ownership remains private; this proof verifies selection of the ticket and prize, not the completeness of the private purchase ledger.</li>
            </ol>
            {proof && <>
                <div className="my-3 flex flex-wrap gap-3"><button type="button" onClick={() => copy(JSON.stringify(proof, null, 2))}>Copy proof values</button><a href="/raffle-fairness-verifier.mjs" download>Download independent verifier</a></div>
                <label className="block">Previously saved commitment hash (optional)<input className="mt-1 w-full rounded border bg-transparent p-2 font-mono text-xs" value={savedHash} onChange={event => setSavedHash(event.target.value)} /></label>
                {proof.result && <button type="button" disabled={busy} onClick={verify} className="my-3">Verify winner and prize</button>}
                <details className="my-3"><summary>Proof values (includes ticket total)</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(proof, null, 2)}</pre></details>
                <details><summary>Run verification independently</summary><p>Save the copied values as proof.json in a new folder with the downloaded verifier, then run:</p><pre className="overflow-auto text-xs">{'npm install --save-exact drand-client@1.4.2\nnode raffle-fairness-verifier.mjs proof.json'}</pre><p>The verifier works locally with the supplied signed beacon. No kHub login or network beacon request is needed. Add your previously saved commitment hash as the last command argument to compare it.</p><p>Algorithm: SHA-256 of method + newline + commitmentHash + newline + randomness yields seed. SHA-256 of method + newline + seed + newline + domain (ticket or prize) + newline + decimal counter (starting at 0) yields each 256-bit sample. Reject samples at or above 2^256 − (2^256 mod bound), then take sample mod bound. Ticket bound is the committed total; add 1 and the committed label offset. Prize bound is 10000; choose the first cumulative prize weight strictly above the sampled index.</p></details>
            </>}
            {busy && <p role="status">Working…</p>}{message && <p role="status">{message}</p>}
        </dialog></div>}
        {!open && message && <p role="status">{message}</p>}
    </section>;
}
RaffleFairness.propTypes = { raffleId: PropTypes.string.isRequired, viewerId: PropTypes.string.isRequired, revision: PropTypes.number.isRequired };
