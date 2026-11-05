import { Link } from 'react-router-dom';
import { watchRaffleCommitment } from '../lib/raffleCommitmentRefresh';
import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';

function FairnessIcon({ kind }) {
    const paths = {
        refresh: 'M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M3 21v-5h5',
        copy: 'M9 9h11v12H9V9ZM5 15H3V3h11v2',
        external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
        check: 'm5 12 4 4L19 6',
    };
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={kind === 'refresh' ? 1.9 : 1.7} strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>;
}
FairnessIcon.propTypes = { kind: PropTypes.string.isRequired };

export default function RaffleFairness({ raffleId, viewerId, revision, endsAt }) {
    const dialogRef = useRef(null);
    const backdropPointerDown = useRef(false);
    const copyTimer = useRef(null);
    const [refreshing, setRefreshing] = useState(false);
    const [hashCopied, setHashCopied] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [summary, setSummary] = useState(null);
    const [proof, setProof] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [verification, setVerification] = useState(null);
    const [savedHash, setSavedHash] = useState('');
    useEffect(() => {
        if (open && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    }, [open]);
    useEffect(() => () => clearTimeout(copyTimer.current), []);
    useEffect(() => {
        let active = true;
        const stop = watchRaffleCommitment({
            read: async () => {
                if (active) setRefreshing(true);
                try {
                    const { data, error } = await supabase.rpc('read_raffle_fairness_summary', { p_id: raffleId });
                    if (error) throw error;
                    return data;
                } finally { if (active) setRefreshing(false); }
            },
            onValue: setSummary,
            onError: () => setSummary(previous => previous || { error: true }),
            document, window, endsAt,
        });
        return () => { active = false; stop(); };
    }, [raffleId, viewerId, revision, attempt, endsAt]);
    function isBackdrop(event) {
        if (event.target !== event.currentTarget) return false;
        const bounds = event.currentTarget.getBoundingClientRect();
        return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    }
    async function showDetails() {
        setOpen(true); setBusy(true); setMessage(''); setProof(null); setVerification(null);
        try {
            const { data, error } = await supabase.rpc('read_raffle_fairness_proof', { p_id: raffleId });
            if (error || !data) throw new Error();
            setProof(data);
        } catch { setMessage('Proof unavailable. Please close and try again.'); }
        finally { setBusy(false); }
    }
    async function copy(value, isHash = false) {
        try {
            await navigator.clipboard.writeText(value);
            if (isHash) {
                clearTimeout(copyTimer.current); setHashCopied(true);
                copyTimer.current = setTimeout(() => setHashCopied(false), 2000);
            } else setMessage('Copied.');
        }
        catch { setMessage('Copy unavailable. Select the values below and copy them manually.'); }
    }
    async function verify() {
        setBusy(true); setMessage(''); setVerification({ kind: 'checking', message: 'Checking the winning ticket and prize…' });
        try {
            const { verifyRaffleProof } = await import('../lib/raffleProof');
            const result = await verifyRaffleProof(proof, savedHash.trim());
            setVerification({ kind: 'success', message: `The winning ticket (#${result.winningTicket}) and prize both match the published proof.` });
        } catch (error) {
            setVerification({ kind: 'error', message: "We couldn't verify this draw. Try again, or open Advanced Verification for details.", detail: error.message });
        }
        finally { setBusy(false); }
    }
    return <section className="raffle-summary raffle-fairness mt-4" aria-label="Raffle fairness">
        <div className="raffle-fairness-heading"><h2>Fairness proof</h2><button type="button" className="raffle-fairness-icon-button" title="Refresh proof" aria-label="Refresh proof" aria-busy={refreshing} disabled={refreshing} onClick={() => setAttempt(value => value + 1)}><span className={refreshing ? 'raffle-refresh-spinning' : undefined}><FairnessIcon kind="refresh" /></span></button></div>
        {summary?.error ? <p role="alert">Fairness information unavailable. Refresh to retry.</p> : !summary ? <p>No draw proof is available yet.</p> : ['cancelled', 'empty'].includes(summary.state) ? <p>No draw took place. There is no winner or prize selection to verify.</p> : !summary.required ? <p>This raffle uses the earlier draw method. No public-beacon proof exists for it.</p> : <>
            <p>Both the winning ticket and prize are selected using a signed public randomness beacon and fixed calculations.</p>
            {!summary.commitmentHash ? <p>The input commitment will be published after ticket intake closes, before the selected beacon round.</p> : <>
                <p>{summary.complete ? 'The draw is ready to verify.' : 'Inputs are committed. Waiting for verified public randomness. If gateways are delayed or unavailable, the bot automatically retries the same committed round; no replacement draw is used.'}</p>
                <div className="raffle-commitment-record">
                    <span className="text-xs font-semibold">Draw commitment</span>
                    <div className="raffle-commitment-hash"><code>{summary.commitmentHash}</code><button type="button" className="raffle-fairness-icon-button" title="Copy hash" aria-label="Copy hash" onClick={() => copy(summary.commitmentHash, true)}><FairnessIcon kind={hashCopied ? 'check' : 'copy'} /></button><span className="raffle-copy-confirmation" role="status">{hashCopied ? 'Copied!' : ''}</span></div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span>Recorded by kHub: <time dateTime={summary.committedAt}>{new Date(summary.committedAt).toLocaleString()}</time></span>
                        <Link className="raffle-commitment-link" to={`/raffle/${raffleId}/commitment`}>Permanent public record<FairnessIcon kind="external" /></Link>
                    </div>
                    {!summary.complete && <p>Scheduled randomness: <time dateTime={new Date((1692803367 + (summary.round - 1) * 3) * 1000).toISOString()}>{new Date((1692803367 + (summary.round - 1) * 3) * 1000).toLocaleString()}</time>. The commitment is fixed at least two minutes before this round.</p>}
                </div>
                <button type="button" onClick={showDetails} className="raffle-verification-details">Verification details</button>
            </>}
        </>}
        {open && <div className="raffle-proof-overlay"><dialog ref={dialogRef} onPointerDown={event => { backdropPointerDown.current = isBackdrop(event); }} onClick={event => {
            if (backdropPointerDown.current && isBackdrop(event)) { setOpen(false); setMessage(''); }
            backdropPointerDown.current = false;
        }} onCancel={() => { setOpen(false); setMessage(''); }} aria-modal="true" aria-labelledby="raffle-proof-title" className="raffle-proof-dialog">
            <div className="flex items-center justify-between gap-4"><h2 id="raffle-proof-title">Verify the Draw</h2><button type="button" onClick={() => { setOpen(false); setMessage(''); }}>Close</button></div>
            <p className="raffle-proof-intro">Every raffle uses public randomness to select its winning ticket and prize. You can check the result yourself using the verification tool below.</p>
            <button type="button" disabled={busy || !proof?.result} onClick={verify} className="raffle-proof-primary">{verification?.kind === 'checking' ? 'Checking…' : 'Verify Winner & Prize'}</button>
            {verification && <div role={verification.kind === 'error' ? 'alert' : 'status'} className={`raffle-proof-result is-${verification.kind}`}><strong>{verification.kind === 'success' ? 'Draw matches' : verification.kind === 'error' ? 'Unable to verify' : 'Checking result'}</strong><p>{verification.message}</p></div>}
            {busy && !proof && <p role="status">Loading the draw details…</p>}
            {proof && !proof.result && <p>The draw is still pending. You can verify it once the result is available.</p>}
            {proof && <details className="raffle-proof-advanced"><summary>Advanced Verification</summary>
            <ol className="list-decimal space-y-2 pl-5">
                <li><strong>Verify the commitment.</strong> Compare the commitment hash with any previously saved copy. Confirm that the SHA-256 hash of the original raffle manifest matches the recorded commitment.</li>
                <li><strong>Validate the raffle details.</strong> Check that the manifest contains the correct raffle ID, predetermined drand round, ticket total, ticket numbering, and prize probabilities.</li>
                <li><strong>Verify public randomness.</strong> Validate the drand Quicknet beacon&apos;s cryptographic signature and confirm that its published randomness matches the signed beacon.</li>
                <li><strong>Reproduce the draw.</strong> Use the verified randomness and committed raffle details to independently calculate the winning ticket and prize using the published selection algorithm.</li>
                <li><strong>Confirm the outcome.</strong> Compare the calculated winning ticket and selected prize against the officially announced results.</li>
            </ol>
                <div className="my-3 flex flex-wrap gap-3"><button type="button" onClick={() => copy(JSON.stringify(proof, null, 2))}><strong>Copy proof values</strong></button><span aria-hidden="true">|</span><a href="/raffle-fairness-verifier.mjs" download><strong>Download independent verifier</strong></a></div>
                <label className="block">Previously saved commitment hash (optional)<input className="mt-1 w-full rounded border bg-transparent p-2 font-mono text-xs" value={savedHash} onChange={event => setSavedHash(event.target.value)} /></label>
                {verification?.detail && <p role="note">Verification details: {verification.detail}</p>}
                <details className="my-3"><summary>Proof values</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(proof, null, 2)}</pre></details>
                <details><summary>Run Verification Independently</summary>
                    <ol className="mt-2 list-decimal space-y-2 pl-5">
                        <li>Download the independent verifier and copy the proof values.</li>
                        <li>Save the proof values as <code>proof.json</code> in the same folder as the verifier.</li>
                        <li>Run these commands in that folder:</li>
                    </ol>
                    <pre className="my-3 overflow-auto text-xs"><code>{'npm install --save-exact drand-client@1.4.2\nnode raffle-fairness-verifier.mjs proof.json'}</code></pre>
                    <p>The verifier will independently check the winning ticket and prize.</p>
                    <p><em>Optional: To verify the original commitment, copy the commitment hash displayed on the raffle page and add it to the end of the second command.</em></p>
                </details>
            </details>}
            {message && <p role="status">{message}</p>}
        </dialog></div>}
        {!open && message && <p role="status">{message}</p>}
    </section>;
}
RaffleFairness.propTypes = { raffleId: PropTypes.string.isRequired, viewerId: PropTypes.string.isRequired, revision: PropTypes.number.isRequired, endsAt: PropTypes.string };
