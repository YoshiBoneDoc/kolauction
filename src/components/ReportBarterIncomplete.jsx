import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { writeBarter } from '../lib/barter';

export default function ReportBarterIncomplete({ auctionId }) {
    const dialog = useRef(null);
    const request = useRef(null);
    const lock = useRef(false);
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit(event) {
        event.preventDefault();
        if (lock.current) return;
        lock.current = true; setPending(true); setError('');
        try {
            request.current ||= crypto.randomUUID();
            await writeBarter('report_barter_incomplete', { p_id: auctionId, p_request: request.current, p_body: body });
            dialog.current?.close();
        } catch (failure) { setError(failure.message); }
        finally { lock.current = false; setPending(false); }
    }
    return <>
        <button type="button" onClick={() => dialog.current.showModal()} className="button-red inline-flex min-h-8 items-center justify-center rounded border px-3 py-1.5 text-xs font-medium">Report Incomplete</button>
        <dialog ref={dialog} onCancel={event => { if (lock.current) event.preventDefault(); }} aria-label="Report incomplete barter" className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl bg-white p-6 backdrop:bg-black/40">
            <form onSubmit={submit} className="space-y-4">
                <h2 className="text-xl font-bold">Report Incomplete Trade</h2>
                <p className="text-sm">Submit only if the other player did not complete their side of the exchange. This records your incomplete response and sends an administrator support ticket and a KMail notice to the other player. Your optional feedback rating is separate.</p>
                <label className="block">Explanation (optional)<textarea value={body} maxLength={1800} disabled={pending} onChange={event => { setBody(event.target.value); request.current = null; }} rows={5} className="mt-2 block w-full rounded border p-2" /></label>
                {error && <p role="alert" className="text-red-700">{error}</p>}
                <div className="flex justify-end gap-3"><button type="button" disabled={pending} onClick={() => dialog.current.close()}>Cancel</button><button disabled={pending} className="button-red rounded px-3 py-2">{pending ? 'Saving…' : 'Report Incomplete'}</button></div>
            </form>
        </dialog>
    </>;
}
ReportBarterIncomplete.propTypes = { auctionId: PropTypes.string.isRequired };
