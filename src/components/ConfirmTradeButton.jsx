import { useContext, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';

export default function ConfirmTradeButton({ auctionId, className, onConfirmed }) {
    const { confirmTrade } = useContext(AuctionsContext);
    const dialog = useRef(null);
    const submitting = useRef(false);
    const id = useId();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    async function confirm() {
        if (submitting.current) return;
        submitting.current = true;
        setPending(true);
        setError('');
        try {
            await confirmTrade(auctionId);
            dialog.current?.close();
            onConfirmed?.();
        } catch (failure) { setError(failure.message); }
        finally { submitting.current = false; setPending(false); }
    }

    return <>
        <button type="button" disabled={pending} aria-haspopup="dialog" aria-controls={`${id}-dialog`} onClick={() => { setError(''); dialog.current.showModal(); }} className={className}>Confirm Complete</button>
        <dialog ref={dialog} id={`${id}-dialog`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { if (submitting.current) event.preventDefault(); }} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border-0 bg-white p-6 text-gray-800 shadow-xl backdrop:bg-black/40">
            <h2 id={`${id}-title`} className="text-xl font-bold">Confirm Trade Complete?</h2>
            <div id={`${id}-description`} className="mt-3 space-y-4 text-sm leading-6">
                <p>By confirming, you acknowledge that the agreed-upon in-game exchange has been completed and <strong>you have received the items or Meat owed to you.</strong></p>
                <p>Only confirm once the trade is complete. The other party will be notified of your confirmation.</p>
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
            <div className="mt-6 flex flex-wrap justify-end gap-3">
                <button type="button" disabled={pending} onClick={() => dialog.current.close()} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 disabled:opacity-50">Cancel</button>
                <button type="button" disabled={pending} onClick={confirm} className="button-green rounded-lg border border-green-700 bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{pending ? 'Saving…' : 'Confirm'}</button>
            </div>
        </dialog>
    </>;
}
ConfirmTradeButton.propTypes = { auctionId: PropTypes.string.isRequired, className: PropTypes.string, onConfirmed: PropTypes.func };
