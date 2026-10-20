import { useContext, useState } from 'react';
import PropTypes from 'prop-types';
import { AuctionsContext } from '../context/AuctionsContext';
import { createBugReportService } from '../lib/bugReports';
import { supabase } from '../lib/supabase';

const reports = createBugReportService(supabase);

export default function WithdrawTradeRating({ auctionId }) {
    const { refreshAuctions } = useContext(AuctionsContext);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function withdraw() {
        if (pending || !window.confirm('Withdraw your thumbs down? Its negative count will be removed and the inbox report marked resolved by you. This does not give a thumbs up or confirm receipt of the trade.')) return;
        setPending(true);
        setError('');
        try { await reports.withdrawTradeRating(auctionId); await refreshAuctions(); }
        catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <div className="space-y-2">
        <button disabled={pending} onClick={withdraw} className="min-h-11 rounded border border-gray-400 bg-white px-4 py-2 text-sm text-blue-700 disabled:opacity-50">{pending ? 'Saving…' : 'Withdraw thumbs down'}</button>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>;
}
WithdrawTradeRating.propTypes = { auctionId: PropTypes.string.isRequired };
