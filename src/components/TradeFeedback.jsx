import { useContext, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import ThumbIcon from './ThumbIcon';
import { AuctionsContext } from '../context/AuctionsContext';

export default function TradeFeedback({ auctionId, role, rating = null }) {
    const { rateTrade } = useContext(AuctionsContext);
    const [savedRating, setSavedRating] = useState(rating);
    const [pending, setPending] = useState(false);
    const [savedThisVisit, setSavedThisVisit] = useState(false);
    const [error, setError] = useState('');
    const submitting = useRef(false);
    useEffect(() => { setSavedRating(rating); }, [rating]);
    const selected = savedRating ?? rating;
    async function rate(value) {
        if (submitting.current || selected === value) return;
        submitting.current = true;
        setPending(true);
        setError('');
        try {
            await rateTrade(auctionId, value);
            setSavedRating(value);
            setSavedThisVisit(true);
        } catch (failure) { setError(failure.message); }
        finally { submitting.current = false; setPending(false); }
    }
    if (selected != null) return savedThisVisit ? <p role="status" className="pt-5 text-xs text-gray-500">Rating saved</p> : null;
    return <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3" aria-label={`Rate this ${role}`}>
        <p className="text-sm font-semibold text-gray-900">How was your experience trading with this player?</p>
        <div className="flex items-center gap-3">
            {[1, -1].map(value => <button key={value} type="button" aria-label={`Thumbs ${value === 1 ? 'up' : 'down'} for this ${role}`} aria-pressed={selected === value} disabled={pending}
                onClick={() => rate(value)} className={`inline-flex h-16 w-16 items-center justify-center rounded border !p-1.5 !outline-none transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 ${value === 1 ? `text-green-600 hover:!border-green-200 hover:!bg-green-50 focus-visible:ring-green-500 ${selected === value ? 'border-green-300 !bg-green-50' : 'border-transparent !bg-transparent'}` : `text-red-600 hover:!border-red-200 hover:!bg-red-50 focus-visible:ring-red-500 ${selected === value ? 'border-red-300 !bg-red-50' : 'border-transparent !bg-transparent'}`}`}>
                <ThumbIcon down={value === -1} className="h-12 w-12 shrink-0" />
            </button>)}
            <span role="status" className="text-xs text-gray-500">{pending ? 'Saving…' : selected != null ? 'Rating saved' : ''}</span>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>;
}
TradeFeedback.propTypes = { auctionId: PropTypes.string.isRequired, role: PropTypes.oneOf(['buyer', 'seller']).isRequired, rating: PropTypes.oneOf([1, -1]) };
