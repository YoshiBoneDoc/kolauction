import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
export default function HighRollersInvitation() {
    const { currentUser } = useContext(UserContext);
    const id = currentUser?.id;
    const [invitation, setInvitation] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!id) return;
        let active = true;
        async function check() {
            try {
                const { data, error: failure } = await supabase.rpc('read_my_high_rollers_invitation');
                if (active && !failure) setInvitation(data ? { id, version: data } : null);
            } catch { /* Retry on focus. */ }
        }
        void check();
        window.addEventListener('focus', check);
        return () => { active = false; window.removeEventListener('focus', check); };
    }, [id]);
    if (!id || invitation?.id !== id) return null;
    async function respond(accept) {
        setBusy(true); setError('');
        try {
            const { error: failure } = await supabase.rpc('respond_high_rollers_invitation', { p_accept: accept, p_terms_version: invitation.version });
            if (failure) throw failure;
            setInvitation(null);
            window.dispatchEvent(new Event('khub:refresh-account'));
        } catch { setError('Could not save your response. Please try again or refresh.'); }
        finally { setBusy(false); }
    }
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"><dialog open aria-modal="true" aria-labelledby="club-invite-title" className="relative m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 text-gray-900 shadow-xl">
        <h2 id="club-invite-title" className="mb-4 text-2xl font-bold">You&apos;ve Been Invited.</h2>
        <p>Someone has recommended you for induction into the <strong>MMG High Rollers Club</strong>.</p>
        <p className="my-4">By accepting, you acknowledge:</p>
        <ul className="list-disc space-y-3 pl-5">
            <li><strong>The first rule of MMG:</strong> You don&apos;t talk about MMG. Keep this club&apos;s existence, purpose, members, and activities hush-hush. Don&apos;t even ask others if they&apos;re members. I&apos;m serious.</li>
            <li><strong>Fortune favors the bold.</strong> Games of chance carry risks. You participate voluntarily, accept potential losses, and agree not to be a baby about it.</li>
            <li><strong>Fair play is sacred.</strong> You retain the right to request proof of a provably fair outcome for any game you&apos;ve participated in.</li>
            <li><strong>What happens in MMG stays in MMG.</strong> You agree not to report the society solely for hosting games of chance in which you voluntarily participate.</li>
            <li><strong>Membership is a privilege.</strong> Your membership may be revoked at any time, for any reason.</li>
        </ul>
        {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
        <div className="mt-6 flex justify-end gap-3"><button disabled={busy} onClick={() => respond(false)} className="rounded border px-4 py-2">Decline</button><button autoFocus disabled={busy} onClick={() => respond(true)} className="rounded bg-violet-700 px-4 py-2 text-white">Accept Invitation</button></div>
    </dialog></div>;
}
