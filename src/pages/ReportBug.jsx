import { useContext, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { BUG_REPORT_MAX_LENGTH, createBugReportService } from '../lib/bugReports';

const reports = createBugReportService(supabase);

function ReportForm({ support }) {
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [reference, setReference] = useState('');
    const requestId = useRef(null);

    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try {
            // Retain this key/text after an uncertain response, so retrying cannot
            // save a second report or queue another copy of the notification.
            requestId.current ||= crypto.randomUUID();
            const result = support
                ? await reports.submitSupportTicket(requestId.current, body)
                : await reports.submit(requestId.current, body);
            setReference(result.reference);
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }

    if (reference) return <div role="status" className="space-y-3 rounded border border-green-300 bg-green-50 p-4">
        <p className="font-semibold">{support ? 'Support ticket saved' : 'Report saved'}: {reference}</p>
        <p>A KMail copy has been queued for teres Minor (#3552305). {support ? 'An administrator will review your request.' : 'Thank you for helping us fix it.'}</p>
        <button onClick={() => { setBody(''); setReference(''); requestId.current = null; }} className="min-h-11 text-blue-700 underline">{support ? 'Submit another ticket' : 'Report another bug'}</button>
    </div>;

    return <form onSubmit={submit} className="space-y-3 rounded-lg border bg-white p-4 sm:p-6">
        <label htmlFor="bug-description" className="block font-semibold">{support ? 'How can we help?' : 'What went wrong?'}</label>
        <p id="bug-help" className="text-sm text-gray-600">{support ? 'Describe what you need help with and include any relevant details. Please leave out passwords.' : 'Describe what happened and how to reproduce it. Please leave out passwords.'}</p>
        <textarea id="bug-description" rows={8} required minLength={10} maxLength={BUG_REPORT_MAX_LENGTH} disabled={pending}
            value={body} onChange={event => { setBody(event.target.value); setError(''); requestId.current = null; }}
            aria-describedby="bug-help bug-length" className="block w-full min-w-0 rounded border border-gray-400 p-3 text-base text-gray-900" />
        <p id="bug-length" className="text-right text-xs text-gray-600">{body.length.toLocaleString('en-US')} / 2,000 characters</p>
        {error && <p role="alert" className="break-words text-red-700">{error}</p>}
        <button type="submit" disabled={pending} className="min-h-11 rounded bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : support ? 'Submit support ticket' : 'Send bug report'}</button>
    </form>;
}

ReportForm.propTypes = { support: PropTypes.bool.isRequired };

export default function ReportBug({ support = false }) {
    const { currentUser } = useContext(UserContext);
    return <div className="site-page-background flex flex-1 flex-col bg-gray-50">
        <main className="mx-auto w-full max-w-2xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <h1 className="text-3xl font-bold text-blue-700">{support ? 'Submit a Support Ticket' : 'Report a Bug'}</h1>
            <p className="text-sm text-gray-700">{support ? 'Support tickets' : 'Reports'} are private to administrators.</p>
            {currentUser ? <ReportForm key={`${support}:${currentUser.id}`} support={support} /> : <div className="space-y-3 rounded border bg-white p-4">
                <p><Link to="/login" className="text-blue-700 underline">Log in</Link> to {support ? 'submit a support ticket' : 'send a report'}.</p>
                <p className="text-sm">Having trouble logging in? <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3552305" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">KMail teres Minor directly</a>.</p>
            </div>}
        </main>
        <SiteFooter />
    </div>;
}
ReportBug.propTypes = { support: PropTypes.bool };
