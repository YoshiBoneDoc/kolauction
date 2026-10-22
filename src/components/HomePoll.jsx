import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createPollService } from '../lib/polls';
import PollResults from './PollResults';
import PollVoters from './PollVoters';
import { startAuctionRefresh } from '../lib/auctionRefresh';

const polls = createPollService(supabase);

export function PollPanel({ service = polls }) {
    const [feed, setFeed] = useState(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [selectedResult, setSelectedResult] = useState(null);
    const writing = useRef(false);
    const generation = useRef(0);
    const poll = feed?.poll;
    const isAdmin = feed?.can_manage === true || poll?.can_manage === true;
    const published = (feed?.published_results || []).filter(result => (isAdmin || result.has_voted) && result.id !== poll?.id);
    useEffect(() => {
        let cancelled = false;
        async function refresh() {
            if (writing.current) return;
            const request = ++generation.current;
            try {
                const data = await service.read();
                if (!cancelled && request === generation.current) { setFeed(data); setError(''); }
            } catch (failure) { if (!cancelled && request === generation.current) setError(failure.message); }
        }
        const stop = typeof document === 'undefined'
            ? (refresh(), () => {})
            : startAuctionRefresh({ refresh, delay: 30000, document, window });
        return () => { cancelled = true; stop(); };
    }, [service, attempt]);

    async function vote(answer) {
        if (writing.current || isAdmin) return;
        writing.current = true;
        generation.current += 1;
        setPending(true); setError('');
        try {
            await service.vote(poll.id, answer);
            setFeed(previous => {
                const voted = { ...previous.poll, has_voted: true };
                return { ...previous, poll: voted, answered_polls: [...(previous.answered_polls || []).filter(item => item.id !== voted.id), voted] };
            });
            setFeed(await service.read());
        } catch (failure) { setError(failure.message); }
        finally { writing.current = false; setPending(false); }
    }
    async function close(pollId) {
        if (writing.current) return;
        writing.current = true;
        generation.current += 1;
        setPending(true); setError('');
        try {
            await service.close(pollId);
            setFeed(previous => ({ ...previous, answered_polls: (previous.answered_polls || []).filter(item => item.id !== pollId) }));
            setFeed(await service.read());
        } catch (failure) { setError(failure.message); }
        finally { writing.current = false; setPending(false); }
    }
    const answered = (feed?.answered_polls || (poll?.has_voted || isAdmin && poll?.results ? [poll] : [])).filter(item => isAdmin || item.has_voted);
    const results = [...answered, ...published.filter(item => !answered.some(answer => answer.id === item.id))];
    const resultIndex = Math.max(0, results.findIndex(item => item.id === selectedResult));
    const result = results[resultIndex];
    function navigateResults(direction) {
        setSelectedResult(results[(resultIndex + direction + results.length) % results.length].id);
    }
    const question = !isAdmin && poll?.active && !poll.has_voted ? poll : null;
    if (!question && !answered.length && !published.length && !feed?.can_manage && !error) return null;
    return <section aria-label="Community poll" className="mx-auto mb-6 w-full max-w-6xl space-y-3">
        {question && <div className="rounded-md border border-yellow-300 bg-yellow-100 px-5 py-5 text-slate-800 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1 basis-64">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-yellow-800">Community poll</p>
                    <h2 className="text-lg font-semibold leading-6">{question.question}</h2>
                </div>
                <div className="flex gap-2" role="group" aria-label="Your vote">
                    <button type="button" disabled={pending} onClick={() => vote(true)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-yellow-800 px-5 py-2 text-sm font-semibold text-white hover:bg-yellow-900 disabled:opacity-60">Yes</button>
                    <button type="button" disabled={pending} onClick={() => vote(false)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-white px-5 py-2 text-sm font-semibold text-yellow-900 hover:bg-yellow-50 disabled:opacity-60">No</button>
                </div>
            </div>
        </div>}
        {result && <article aria-label={`Results: ${result.question}`} className="max-w-sm rounded-md border border-yellow-200 bg-yellow-50 px-3 py-3 text-slate-800">
            <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-yellow-800">{result.active ? 'Live poll results' : 'Previous poll results'}</p>
                {results.length > 1 && <div role="group" aria-label="Browse poll results" className="flex shrink-0 items-center gap-1">
                    <button type="button" aria-label="Previous poll results" onClick={() => navigateResults(-1)} className="poll-result-arrow">
                        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 12 12" fill="currentColor"><path d="M9 1 2 6l7 5Z" /></svg>
                    </button>
                    <span className="text-xs text-yellow-800" aria-live="polite">{resultIndex + 1} / {results.length}</span>
                    <button type="button" aria-label="Next poll results" onClick={() => navigateResults(1)} className="poll-result-arrow">
                        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 12 12" fill="currentColor"><path d="m3 1 7 5-7 5Z" /></svg>
                    </button>
                </div>}
            </div>
            <h2 className="text-sm font-medium leading-5">{result.question}</h2>
            <div className="mt-2 space-y-2">
                {result.can_manage && <p className="text-xs font-semibold">Admin results</p>}
                {result.results ? <PollResults results={result.results} compact /> : <p className="text-xs text-gray-500">{error ? 'Results unavailable.' : 'Loading results…'}</p>}
                {result.can_manage && <PollVoters key={result.id} pollId={result.id} service={service} />}
                {result.can_manage && <div className="flex flex-wrap gap-4 text-xs">
                    <button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)} className="text-blue-800 underline disabled:opacity-60">Refresh results</button>
                    {result.active && <button type="button" disabled={pending} onClick={() => close(result.id)} className="text-slate-700 underline disabled:opacity-60">Conclude poll</button>}
                </div>}
            </div>
        </article>}
        {feed?.can_manage && <p className="text-sm"><Link to="/admin/polls" className="text-blue-800 underline">Manage polls &amp; view past results</Link></p>}
        {error && <p role="alert" className="text-sm text-red-800">{error}{' '}<button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)} className="underline">Retry</button></p>}
    </section>;
}
PollPanel.propTypes = { service: PropTypes.object };

export default function HomePoll() {
    const { currentUser } = useContext(UserContext);
    return currentUser && !currentUser.isBanned ? <PollPanel key={currentUser.id} /> : null;
}
