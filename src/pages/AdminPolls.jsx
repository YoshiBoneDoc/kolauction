import { useContext, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createPollService } from '../lib/polls';
import PollResults from '../components/PollResults';
import PollVoters from '../components/PollVoters';
import SiteFooter from '../components/SiteFooter';

const polls = createPollService(supabase);

export function PollManager({ service = polls }) {
    const [records, setRecords] = useState(null);
    const [question, setQuestion] = useState('');
    const [pollType, setPollType] = useState('yes_no');
    const [multiple, setMultiple] = useState(false);
    const [editing, setEditing] = useState(null);
    const [pending, setPending] = useState(false);
    const writing = useRef(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        service.list().then(data => { if (!cancelled) { setRecords(data); setError(''); } })
            .catch(failure => { if (!cancelled) setError(failure.message); });
        return () => { cancelled = true; };
    }, [service, attempt]);
    async function action(run) {
        if (writing.current) return;
        writing.current = true;
        setPending(true); setError('');
        try { await run(); setRecords(await service.list()); }
        catch (failure) { setError(failure.message); }
        finally { writing.current = false;setPending(false); }
    }
    async function save(event) {
        event.preventDefault();
        await action(async () => { await service.saveDraft(question, editing, pollType, pollType === 'free_text' && multiple); setQuestion(''); setEditing(null); setPollType('yes_no'); setMultiple(false); });
    }
    const button = 'min-h-9 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-gray-100 disabled:opacity-50';
    return <>
        <div className="flex justify-end"><button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)} className="text-sm text-blue-700 underline disabled:opacity-50">Refresh results</button></div>
        {error && <p role="alert" className="text-sm text-red-700">{error}{' '}<button type="button" onClick={() => setAttempt(value => value + 1)} className="underline">Retry</button></p>}
        {!records ? !error && <p role="status">Loading polls…</p> : <>
            <form onSubmit={save} className="space-y-3 rounded-lg border bg-white p-4">
                <label htmlFor="poll-question" className="block text-sm font-semibold">{editing ? 'Edit draft question' : 'Prepare a new poll'}</label>
                <div className="flex flex-wrap items-center gap-3">
                    <label htmlFor="poll-type" className="text-sm">Answer type</label>
                    <select id="poll-type" value={pollType} disabled={pending} onChange={event => { setPollType(event.target.value);setMultiple(false); }} className="rounded border border-gray-300 bg-white p-2 text-sm text-slate-800">
                        <option value="yes_no">Yes / No</option><option value="free_text">Free text</option>
                    </select>
                    {pollType === 'free_text' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={multiple} disabled={pending} onChange={event => setMultiple(event.target.checked)} />Allow multiple responses</label>}
                </div>
                <textarea id="poll-question" value={question} onChange={event => setQuestion(event.target.value)} minLength={10} maxLength={300} required rows={2}
                    placeholder={pollType === 'free_text' ? 'What would you like to ask players?' : 'Your Yes / No question…'} className="w-full rounded border border-gray-300 bg-white p-3 text-sm text-slate-800" />
                {pollType === 'free_text' && <p className="text-xs text-gray-500">Responses are private and grouped by poll under Other in your inbox.{multiple && ' After answering, players can use “Send another response” to reopen the form.'}</p>}
                <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" disabled={pending || question.trim().length < 10} className={button}>Save draft</button>
                    {editing && <button type="button" disabled={pending} onClick={() => { setEditing(null); setQuestion('');setPollType('yes_no');setMultiple(false); }} className={button}>Cancel edit</button>}
                    <p className="text-xs text-gray-500">Drafts stay private. Publish whenever you’re ready.</p>
                </div>
            </form>
            <div className="space-y-3">{records.map(poll => <article key={poll.id} className="space-y-3 rounded-lg border bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                    <span className={`rounded px-2 py-1 font-semibold ${poll.active ? 'bg-green-100 text-green-800' : poll.closed_at ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-700'}`}>{poll.active ? 'Live' : poll.closed_at ? 'Concluded' : 'Draft'}</span>
                    <span>{poll.closed_at ? 'Concluded' : poll.published_at ? 'Published' : 'Created'} {new Date(poll.closed_at || poll.published_at || poll.created_at).toLocaleString()}</span>
                </div>
                <h2 className="text-base font-semibold text-slate-800">{poll.question}</h2>
                {!poll.published_at && <p className="text-xs text-gray-500">{poll.poll_type === 'free_text' ? `Free text · ${poll.allow_multiple_responses ? 'Multiple responses allowed' : 'One response per player'}` : 'Yes / No'}</p>}
                {poll.published_at && <>
                    {poll.poll_type === 'free_text' ? <p className="text-sm text-gray-600">{poll.results?.total || 0} responses · {poll.allow_multiple_responses ? 'Multiple responses allowed' : 'One response per player'} · <Link to="/admin/inbox?category=other" className="text-blue-700 underline">View in inbox</Link></p> : <><PollResults results={poll.results} /><PollVoters pollId={poll.id} service={service} /></>}
                </>}
                <div className="flex flex-wrap items-center gap-2">
                    {!poll.published_at && <>
                        <button type="button" disabled={pending} onClick={() => { setEditing(poll.id); setQuestion(poll.question);setPollType(poll.poll_type || 'yes_no');setMultiple(Boolean(poll.allow_multiple_responses)); }} className={button}>Edit draft</button>
                        <button type="button" disabled={pending || Boolean(editing)} onClick={() => action(() => service.publish(poll.id))}
                            className="min-h-9 rounded border border-blue-700 bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 disabled:opacity-50">Publish poll</button>
                    </>}
                    {poll.active && <button type="button" disabled={pending} onClick={() => action(() => service.close(poll.id))} className={button}>Conclude poll</button>}
                    {poll.closed_at && poll.poll_type !== 'free_text' && <button type="button" aria-pressed={poll.results_published} disabled={pending} onClick={() => action(() => service.publishResults(poll.id, !poll.results_published))} className={button}>{poll.results_published ? 'Hide homepage results' : 'Publish results on homepage'}</button>}
                    {poll.results_published && <span className="text-xs text-green-700">Results visible to voters on the homepage</span>}
                </div>
            </article>)}</div>
        </>}
    </>;
}

PollManager.propTypes = { service: PropTypes.object };

export default function AdminPolls() {
    const { currentUser } = useContext(UserContext);
    return <div className="flex flex-1 flex-col">
        <main className="mx-auto w-full max-w-4xl flex-1 space-y-5 px-4 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-3xl font-bold text-blue-700">Manage polls</h1>
                <Link to="/admin/inbox" className="text-sm text-blue-700 underline">Administrator inbox</Link>
            </div>
            <p className="text-sm text-gray-600">Multiple polls can be live. Players answer them in publication order. Yes/No results appear after voting; written responses stay private in your inbox.</p>
            {currentUser ? <PollManager key={currentUser.id} /> : <p><Link to="/login" className="text-blue-700 underline">Log in</Link> with your administrator account to manage polls.</p>}
        </main>
        <SiteFooter showReportLink={false} />
    </div>;
}
