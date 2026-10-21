import { useContext, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';
import { createBugReportService } from '../lib/bugReports';
import { supabase } from '../lib/supabase';

const reports = createBugReportService(supabase);

export default function WithdrawTradeRating({ auctionId }) {
    const { refreshAuctions } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const dialog = useRef(null);
    const submitting = useRef(false);
    async function withdraw() {
        if (submitting.current) return;
        submitting.current = true;
        setPending(true);
        setError('');
        try {
            await reports.withdrawTradeRating(auctionId);
            await refreshAuctions();
            dialog.current?.close();
        }
        catch (failure) { setError(failure.message); }
        finally { submitting.current = false; setPending(false); }
    }
    return <div className="space-y-2">
        <button disabled={pending} aria-haspopup="dialog" aria-controls={`withdraw-dialog-${auctionId}`} onClick={() => { setError(''); dialog.current.showModal(); }} className="button-green w-fit whitespace-nowrap rounded-[8px] border border-solid border-[#BBF7D0] bg-[#F0FDF4] px-[18px] py-[10px] text-sm font-medium text-[#166534] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:opacity-50">Mark Trade Complete</button>
        <dialog id={`withdraw-dialog-${auctionId}`} ref={dialog} aria-labelledby={`withdraw-title-${auctionId}`} aria-describedby={`withdraw-description-${auctionId}`} onCancel={event => { if (submitting.current) event.preventDefault(); }} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border-0 bg-white p-6 text-gray-800 shadow-xl backdrop:bg-black/40">
            <h2 id={`withdraw-title-${auctionId}`} className="text-xl font-bold">Withdraw Incomplete Report?</h2>
            <p id={`withdraw-description-${auctionId}`} className="mt-3 text-sm leading-6">By withdrawing this report, you confirm that the issue has been resolved and the <strong>trade was successfully completed</strong>. Your incomplete report will be withdrawn. Your separate feedback rating will stay unchanged.</p>
            {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
            <div className="mt-6 flex flex-wrap justify-end gap-3">
                <button type="button" disabled={pending} onClick={() => dialog.current.close()} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 disabled:opacity-50">Cancel</button>
                <button type="button" disabled={pending} onClick={withdraw} className="button-green rounded-lg border border-green-700 bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{pending ? 'Saving…' : "Everything's good now"}</button>
            </div>
        </dialog>
    </div>;
}
WithdrawTradeRating.propTypes = { auctionId: PropTypes.string.isRequired };
