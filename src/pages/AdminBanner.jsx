import { useContext, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createSiteBannerService } from '../lib/siteBanner';
import SiteFooter from '../components/SiteFooter';

const announcements = createSiteBannerService(supabase);
export function BannerManager({ service = announcements }) {
    const [loaded, setLoaded] = useState(false);
    const [message, setMessage] = useState('');
    const [active, setActive] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [attempt, setAttempt] = useState(0);
    const writing = useRef(false);
    useEffect(() => {
        let stopped = false;
        service.manage().then(record => {
            if (!stopped) { setMessage(record.message); setActive(record.active); setLoaded(true); setError(''); }
        }).catch(failure => { if (!stopped) setError(failure.message); });
        return () => { stopped = true; };
    }, [service, attempt]);
    async function save(event) {
        event.preventDefault();
        if (writing.current) return;
        writing.current = true; setPending(true); setError(''); setNotice('');
        try {
            const record = await service.save(message.trim(), active);
            setMessage(record.message); setActive(record.active);
            setNotice(record.active ? 'Announcement published. It will appear across the site within 30 seconds.' : 'Announcement hidden.');
        } catch (failure) { setError(failure.message); }
        finally { writing.current = false; setPending(false); }
    }
    return <>
        {error && <p role="alert" className="text-red-700">{error}{' '}{!loaded && <button onClick={() => setAttempt(value => value + 1)} className="underline">Retry</button>}</p>}
        {!loaded ? !error && <p role="status">Loading announcement…</p> : <form onSubmit={save} className="space-y-4 rounded-lg border bg-white p-5">
            <label htmlFor="banner-message" className="block font-semibold">Announcement message</label>
            <textarea id="banner-message" rows={5} maxLength={2000} required={active} value={message} disabled={pending} onChange={event => setMessage(event.target.value)} className="w-full rounded border border-gray-300 bg-white p-3 text-slate-800" />
            <label className="flex items-center gap-2"><input type="checkbox" checked={active} disabled={pending} onChange={event => setActive(event.target.checked)} />Show this announcement site-wide</label>
            {message.trim() && <div className="space-y-2"><p className="text-xs text-gray-500">Preview</p><p className="whitespace-pre-wrap break-words rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{message.trim()}</p></div>}
            <button type="submit" disabled={pending || (active && !message.trim())} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">{pending ? 'Saving…' : 'Save announcement'}</button>
        </form>}
        {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
    </>;
}
BannerManager.propTypes = { service: PropTypes.object };

export default function AdminBanner() {
    const { currentUser } = useContext(UserContext);
    return <div className="flex flex-1 flex-col">
        <main className="mx-auto w-full max-w-3xl flex-1 space-y-5 px-4 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-3xl font-bold text-blue-700">Site announcement</h1>
                <Link to="/admin/inbox" className="text-sm text-blue-700 underline">Administrator inbox</Link>
            </div>
            <p className="text-sm text-gray-600">Everyone can see the banner and dismiss it with ×. Changing a published message or publishing it again shows it to everyone again.</p>
            {currentUser ? <BannerManager key={currentUser.id} /> : <p><Link to="/login" className="text-blue-700 underline">Log in</Link> with your administrator account to manage announcements.</p>}
        </main>
        <SiteFooter />
    </div>;
}
