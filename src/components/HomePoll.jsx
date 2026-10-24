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
    const [drafts, setDrafts] = useState({});
    const [repeatId, setRepeatId] = useState(null);
    const [notice, setNotice] = useState('');
    const [choice, setChoice] = useState(null);
    const responseRequest = useRef(null);
    const writing = useRef(false);
    const generation = useRef(0);
    const poll = feed?.poll;
    const isAdmin = feed?.can_manage === true || poll?.can_manage === true;
    const published = (feed?.published_results || []).filter(result => result.poll_type !== 'free_text' && (isAdmin || result.has_voted) && result.id !== poll?.id);
    const repeatable = !isAdmin ? (feed?.repeatable_polls || []).filter(item => item.active && item.poll_type === 'free_text' && item.allow_multiple_responses) : [];
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
            if (poll.poll_type === 'multiple_choice') await service.voteChoice(poll.id, answer);
            else await service.vote(poll.id, answer);
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
    async function sendResponse(event, item) {
        event.preventDefault();
        if (writing.current || isAdmin) return;
        const response = (drafts[item.id] || '').trim();
        if (!response || [...response].length > 1500) { setError('Use a response of 1 to 1,500 characters.');return; }
        // Retain the request ID on a failed/uncertain write so a retry cannot
        // create two inbox messages when multiple responses are enabled.
        if (responseRequest.current?.pollId !== item.id || responseRequest.current.response !== response) {
            responseRequest.current = {pollId:item.id,response,id:crypto.randomUUID()};
        }
        writing.current = true;generation.current += 1;setPending(true);setError('');
        try {
            await service.respond(item.id, response, responseRequest.current.id);
            responseRequest.current = null;
            setDrafts(previous => ({...previous,[item.id]:''}));setRepeatId(null);
            setNotice('Thanks! Your response was sent privately to the administrator.');
            setFeed(previous => ({...previous,
                poll: previous.poll?.id === item.id ? {...previous.poll,has_voted:true} : previous.poll,
                repeatable_polls: item.allow_multiple_responses
                    ? [...(previous.repeatable_polls || []).filter(p => p.id !== item.id),item]
                    : previous.repeatable_polls || [],
            }));
            setFeed(await service.read());
        } catch (failure) { setError(failure.message); }
        finally { writing.current = false;setPending(false); }
    }
    function responseForm(item) {
        return <form onSubmit={event => sendResponse(event,item)} className="mt-3 space-y-2">
            <label htmlFor={`poll-response-${item.id}`} className="sr-only">Your response to {item.question}</label>
            <textarea id={`poll-response-${item.id}`} value={drafts[item.id] || ''} onChange={event => setDrafts(previous => ({...previous,[item.id]:event.target.value}))}
                disabled={pending} required maxLength={1500} rows={3} placeholder="Your response…" className="w-full rounded border border-yellow-300 bg-white p-3 text-sm text-slate-800" />
            <div className="flex flex-wrap items-center gap-3">
                <button type="submit" disabled={pending || !(drafts[item.id] || '').trim()} className="min-h-10 rounded border border-yellow-700 bg-yellow-800 px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-900 disabled:opacity-60">{pending ? 'Sending…' : 'Send response'}</button>
                <p className="text-xs text-yellow-800">Only the administrator can read your response.</p>
            </div>
        </form>;
    }
    const answered = (feed?.answered_polls || (poll?.has_voted || isAdmin && poll?.results ? [poll] : [])).filter(item => isAdmin || item.has_voted && item.poll_type !== 'free_text');
    const results = [...answered, ...published.filter(item => !answered.some(answer => answer.id === item.id))];
    const resultIndex = Math.max(0, results.findIndex(item => item.id === selectedResult));
    const result = results[resultIndex];
    function navigateResults(direction) {
        setSelectedResult(results[(resultIndex + direction + results.length) % results.length].id);
    }
    const question = !isAdmin && poll?.active && !poll.has_voted ? poll : null;
    if (!question && !answered.length && !published.length && !repeatable.length && !feed?.can_manage && !error && !notice) return null;
    return <section aria-label="Community poll" className="mx-auto mb-6 w-full max-w-6xl space-y-3">
        {question && <div className="rounded-md border border-yellow-300 bg-yellow-100 px-5 py-5 text-slate-800 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1 basis-64">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-yellow-800">Community poll</p>
                    <h2 className="text-lg font-semibold leading-6">{question.question}</h2>
                </div>
                {!['free_text','multiple_choice'].includes(question.poll_type) && <div className="flex gap-2" role="group" aria-label="Your vote">
                    <button type="button" disabled={pending} onClick={() => vote(true)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-yellow-800 px-5 py-2 text-sm font-semibold text-white hover:bg-yellow-900 disabled:opacity-60">Yes</button>
                    <button type="button" disabled={pending} onClick={() => vote(false)} className="min-h-10 min-w-20 rounded border border-yellow-700 bg-white px-5 py-2 text-sm font-semibold text-yellow-900 hover:bg-yellow-50 disabled:opacity-60">No</button>
                </div>}
            </div>
            {question.poll_type === 'free_text' && responseForm(question)}
            {question.poll_type === 'multiple_choice' && <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault();if (choice?.pollId === question.id) vote(choice.index); }}>
                <fieldset disabled={pending} className="space-y-2">
                    <legend className="sr-only">Choose one answer to {question.question}</legend>
                    {(question.choices || []).map((label,index) => <label key={index} className="flex cursor-pointer items-start gap-2 text-sm leading-5">
                        <input type="radio" name={`poll-choice-${question.id}`} value={index+1} required checked={choice?.pollId === question.id && choice.index === index+1}
                            onChange={() => setChoice({pollId:question.id,index:index+1})} className="mt-0.5 h-4 w-4 shrink-0 accent-yellow-700" />
                        <span className="min-w-0 break-words">{label}</span>
                    </label>)}
                </fieldset>
                <button type="submit" disabled={pending || choice?.pollId !== question.id} className="min-h-10 rounded border border-yellow-700 bg-yellow-800 px-4 py-2 text-sm font-semibold text-white hover:bg-yellow-900 disabled:opacity-60">{pending ? 'Submitting…' : 'Submit vote'}</button>
            </form>}
        </div>}
        {repeatable.map(item => <div key={item.id} className={repeatId === item.id ? 'rounded-md border border-yellow-300 bg-yellow-100 px-5 py-4 text-slate-800' : 'w-fit max-w-full'}>
            <button type="button" disabled={pending} aria-label={`${repeatId === item.id ? 'Close response form' : 'Send another response'}: ${item.question}`} title={item.question}
                aria-expanded={repeatId === item.id} onClick={() => setRepeatId(current => current === item.id ? null : item.id)}
                className="inline-flex min-h-9 max-w-full items-center gap-2 rounded border border-yellow-200 bg-yellow-50 px-3 py-1.5 text-left text-xs text-yellow-900 hover:bg-yellow-100 disabled:opacity-60">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8m-4-4v8M5 19l-2 2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5Z" /></svg>
                <span className="min-w-0 truncate">{repeatId === item.id ? 'Close response form' : 'Send another response'} · {item.question}</span>
            </button>
            {repeatId === item.id && <><h2 className="mt-3 text-lg font-semibold">{item.question}</h2>{responseForm(item)}</>}
        </div>)}
        {notice && <p role="status" className="text-sm text-gray-600">{notice}</p>}
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
                {result.poll_type === 'free_text' ? <p className="text-xs">{result.results?.total || 0} responses · <Link to="/admin/inbox?category=other" className="text-blue-800 underline">View in inbox</Link></p>
                    : result.results ? <PollResults results={result.results} compact /> : <p className="text-xs text-gray-500">{error ? 'Results unavailable.' : 'Loading results…'}</p>}
                {result.can_manage && result.poll_type !== 'free_text' && <PollVoters key={result.id} pollId={result.id} service={service} />}
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
