import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';
import { createPollService } from '../lib/polls';

const polls = createPollService(supabase);

export default function PollVoters({ pollId, service = polls }) {
    const [open, setOpen] = useState(false);
    const [voters, setVoters] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true); setError('');
        service.voters(pollId).then(data => { if (!cancelled) setVoters(data); })
            .catch(failure => { if (!cancelled) setError(failure.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, pollId, service, attempt]);
    return <details onToggle={event => setOpen(event.currentTarget.open)} className="text-sm">
        <summary className="w-fit cursor-pointer text-blue-800">View voters</summary>
        {open && <div className="mt-2 space-y-2">
            {loading ? <p role="status" className="text-gray-500">Loading voters…</p> : error ? <p role="alert" className="text-red-700">{error}</p> : voters && <div className="grid gap-3 sm:grid-cols-2">
                <p className="break-words"><strong>Yes:</strong> {voters.yes.length ? voters.yes.join(', ') : 'No votes yet.'}</p>
                <p className="break-words"><strong>No:</strong> {voters.no.length ? voters.no.join(', ') : 'No votes yet.'}</p>
            </div>}
            <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)} className="text-xs text-blue-800 underline disabled:opacity-50">Refresh voters</button>
        </div>}
    </details>;
}
PollVoters.propTypes = { pollId: PropTypes.string.isRequired, service: PropTypes.object };
