import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createPollService } from '../lib/polls';
import PollResults from './PollResults';

const polls = createPollService(supabase);

export function PollPanel({ service = polls }) {
    const [feed, setFeed] = useState(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const poll = feed?.poll;
    const published = (feed?.published_results || []).filter(result => result.id !== poll?.id);
    useEffect(() => {
        let cancelled = false;
        service.read().then(data => {
            if (!cancelled) { setFeed(data); setError(''); }
        }).catch(failure => { if (!cancelled) setError(failure.message); });
        return () => { cancelled = true; };
    }, [service, attempt]);

    async function vote(answer) {
        if (pending) return;
        setPending(true); setError('');
        try {
            await service.vote(poll.id, answer);
            if (feed.can_manage) {
                setFeed(previous => ({ ...previous, poll: { ...previous.poll, has_voted: true } }));
                setFeed(await service.read());
            } else setFeed(previous => ({ ...previous, poll: null }));
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    async function close() {
        if (pending) return;
        setPending(true); setError('');
        try {
            await service.close(poll.id);
            setFeed(previous => ({ ...previous, poll: { ...previous.poll, active: false } }));
            setFeed(await service.read());
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    if (!poll && !published.length && !feed?.can_manage && !error) return null;
    return <section aria-label="Community poll" className="mx-auto mb-6 w-full max-w-6xl rounded-md border border-yellow-300 bg-yellow-100 px-5 py-5 text-slate-800 sm:px-6">
        {poll && <>
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1 basis-64">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-yellow-800">Community poll{!poll.active ? ' · Closed' : ''}</p>
                    <h2 className="text-lg font-semibold leading-6">{poll.question}</h2>
                </div>
                {poll.active && !poll.has_voted && <div className="flex gap-2" role="group" aria-label="Your vote">
                    <button type="button" disabled={pending} onClick={() => vote(true)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-yellow-800 px-5 py-2 text-sm font-semibold text-white hover:bg-yellow-900 disabled:opacity-60">Yes</button>
                    <button type="button" disabled={pending} onClick={() => vote(false)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-white px-5 py-2 text-sm font-semibold text-yellow-900 hover:bg-yellow-50 disabled:opacity-60">No</button>
                </div>}
            </div>
            {poll.can_manage && poll.results && <div className="mt-4 space-y-2 border-t border-yellow-300 pt-3 text-sm">
                <p className="font-semibold">Admin results</p>
                <PollResults results={poll.results} />
                <div className="flex flex-wrap gap-4">
                    <button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)} className="text-blue-800 underline disabled:opacity-60">Refresh results</button>
                    {poll.active && <button type="button" disabled={pending} onClick={close} className="text-slate-700 underline disabled:opacity-60">Conclude poll</button>}
                </div>
            </div>}
        </>}
        {published.length > 0 && <div className={poll ? 'mt-4 space-y-4 border-t border-yellow-300 pt-4' : 'space-y-4'}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-yellow-800">Previous poll results</h2>
            {published.map(result => <div key={result.id}>
                <h3 className="mb-2 text-sm font-semibold">{result.question}</h3>
                <PollResults results={result.results} />
            </div>)}
        </div>}
        {feed?.can_manage && <p className="mt-3 text-sm"><Link to="/admin/polls" className="text-blue-800 underline">Manage polls &amp; view past results</Link></p>}
        {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}{' '}<button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)} className="underline">Retry</button></p>}
    </section>;
}
PollPanel.propTypes = { service: PropTypes.object };

export default function HomePoll() {
    const { currentUser } = useContext(UserContext);
    return currentUser && !currentUser.isBanned ? <PollPanel key={currentUser.id} /> : null;
}
