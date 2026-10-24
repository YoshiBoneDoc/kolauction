import { useContext, useEffect, useRef, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { Link } from 'react-router-dom';
import { readImage, validateAppealImage } from '../lib/accountRestrictions';
import SiteFooter from '../components/SiteFooter';
import { supabase } from '../lib/supabase';
import { createAuthService } from '../lib/auth';
import { BUG_REPORT_MAX_LENGTH, createBugReportService } from '../lib/bugReports';

const auth = createAuthService(supabase);
const reports = createBugReportService(supabase);

function AppealSignIn() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function signIn(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try { await auth.login(username, password, { appeal: true }); }
        catch (failure) { setError(failure.message); }
        finally { setPassword(''); setPending(false); }
    }
    return <form onSubmit={signIn} className="space-y-4 rounded-lg border bg-white p-5">
        <p>Log in to submit an appeal. A site ban does not prevent you from using this form.</p>
        <label className="block text-sm font-semibold" htmlFor="appeal-username">kHub Username</label>
        <input id="appeal-username" autoComplete="username" placeholder="KH_Your KoL name" required value={username}
            onChange={event => setUsername(event.target.value)} className="min-h-11 w-full rounded border border-gray-400 p-3" />
        <label className="block text-sm font-semibold" htmlFor="appeal-password">kHub password</label>
        <input id="appeal-password" type="password" autoComplete="current-password" required value={password}
            onChange={event => setPassword(event.target.value)} className="min-h-11 w-full rounded border border-gray-400 p-3" />
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <button disabled={pending} className="min-h-11 rounded bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{pending ? 'Logging in…' : 'Log in to appeal'}</button>
        <p className="text-xs text-gray-600">If you cannot access your account, <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3552305" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">contact teres Minor by KMail</a>.</p>
    </form>;
}

function AppealForm() {
    const [body, setBody] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [reference, setReference] = useState('');
    const requestId = useRef(null);
    const imageInput = useRef(null);
    const [image, setImage] = useState(null);
    const [preview, setPreview] = useState('');
    useEffect(() => {
        if (!image) { setPreview(''); return; }
        const url = URL.createObjectURL(image);
        setPreview(url);
        return () => URL.revokeObjectURL(url);
    }, [image]);
    async function submit(event) {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        try {
            requestId.current ||= crypto.randomUUID();
            const result = await reports.submitAppeal(requestId.current, body, image ? await readImage(image) : null);
            setReference(result.reference);
        } catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    if (reference) return <div role="status" className="space-y-2 rounded border border-green-300 bg-green-50 p-5">
        <p className="font-semibold">Appeal submitted: {reference}</p>
        <p>An administrator will review it. Submitting an appeal does not lift your ban.</p>
    </div>;
    return <form onSubmit={submit} className="space-y-3 rounded-lg border bg-white p-4 sm:p-6">
        <label htmlFor="appeal-description" className="block font-semibold">Tell us why your ban should be reviewed.</label>
        <p id="appeal-help" className="text-sm text-gray-600">Include what happened and any relevant details. Please leave out passwords.</p>
        <textarea id="appeal-description" rows={8} required minLength={10} maxLength={BUG_REPORT_MAX_LENGTH} disabled={pending}
            value={body} onChange={event => { setBody(event.target.value); setError(''); requestId.current = null; }}
            aria-describedby="appeal-help appeal-length" className="block w-full min-w-0 rounded border border-gray-400 p-3 text-base text-gray-900" />
        <p id="appeal-length" className="text-right text-xs text-gray-600">{body.length.toLocaleString('en-US')} / 2,000 characters</p>
        <label htmlFor="appeal-image" className="block text-sm font-semibold">Evidence image (optional)</label>
        <input ref={imageInput} id="appeal-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={pending} onChange={event => {
            requestId.current = null; setError('');
            const file = event.target.files?.[0];
            if (!file) { setImage(null); return; }
            try { validateAppealImage(file); setImage(file); }
            catch (failure) { setImage(null); event.target.value = ''; setError(failure.message); }
        }} className="block w-full text-sm" />
        <p className="text-xs text-gray-500">One PNG, JPEG or WebP image, up to 2 MB. Only administrators can view submitted evidence.</p>
        {image && <button type="button" disabled={pending} onClick={() => { setImage(null); imageInput.current.value = ''; requestId.current = null; setError(''); }} className="border-0 bg-transparent p-0 text-xs text-gray-600 underline">Remove image</button>}
        {preview && <img src={preview} alt="Appeal evidence preview" className="max-h-64 max-w-full rounded border object-contain" />}
        {error && <p role="alert" className="break-words text-red-700">{error}</p>}
        <button disabled={pending} className="min-h-11 rounded bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-50">{pending ? 'Saving…' : 'Submit appeal'}</button>
    </form>;
}

export default function SubmitAppeal() {
    const { currentUser, signedInUserId, restrictedAccount } = useContext(UserContext);
    const userId = signedInUserId || currentUser?.id;
    return <div className="site-page-background flex flex-1 flex-col bg-gray-50">
        {restrictedAccount && <div className="mx-auto w-full max-w-6xl px-4 sm:px-6"><Link to="/" className="inline-flex min-h-9 items-center text-sm text-blue-700 underline">Back to account status</Link></div>}
        <main className="mx-auto w-full max-w-2xl flex-1 space-y-5 px-4 py-6 sm:px-6">
            <h1 className="text-3xl font-bold text-blue-700">Submit an appeal</h1>
            <p className="text-sm text-gray-700">Appeals are private to administrators. A copy is sent to teres Minor (#3552305) by KMail.</p>
            {userId ? <AppealForm key={userId} /> : <AppealSignIn />}
        </main>
        <SiteFooter />
    </div>;
}
