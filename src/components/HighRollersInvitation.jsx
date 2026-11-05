import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import './HighRollersInvitation.css';
import PropTypes from 'prop-types';

function InvitationIcon({ kind }) {
    const paths = {
        crown: 'm3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm3 10h12',
        secrecy: 'M4 3h16v3H4V3ZM7 6v13M17 6v13M10 9v8M14 9v8M5 19h14v3H5v-3Z',
        fairness: 'M12 3v18M5 21h14M4 6h16M6 6l-4 8h8L6 6Zm12 0-4 8h8l-4-8',
    };
    const detail = kind === 'discretion' ? <>
        <g transform="rotate(-12 8 8)">
            <rect x="2" y="2" width="11" height="11" rx="2" />
            <g fill="currentColor" stroke="none"><circle cx="5" cy="5" r="1" /><circle cx="10" cy="10" r="1" /></g>
        </g>
        <g transform="rotate(12 17 17)">
            <rect x="11" y="11" width="11" height="11" rx="2" />
            <g fill="currentColor" stroke="none"><circle cx="14" cy="14" r="1" /><circle cx="16.5" cy="16.5" r="1" /><circle cx="19" cy="19" r="1" /></g>
        </g>
    </> : kind === 'chance' ? <g strokeWidth="1.5">
        <path d="M4 21 2.5 12C1.5 5 6.5 1.5 13 1.5h6l-2.5 4C10 4.8 5.5 8 6.5 14L7.5 20 4 21Z" />
        <path d="m4 7 1.5 1M7.5 3l1 1.5M12 1.6v2M16 1.6l-.5 1.8" />
        <path d="m8.5 19.5-1-6C6.8 8.5 11 6.5 14.5 7.5c2.5.7 4.2 2.4 5.5 4.5h-4l-1 2.5h5l2 6.5c-4.2 1-7.8.2-11-2l-2.5.5Z" />
        <path d="M7.5 14C11 13 14 11 16 8.2" />
    </g> : kind === 'membership' ? <g>
        {[false, true].map(mirrored => <g key={String(mirrored)} transform={mirrored ? 'translate(24 0) scale(-1 1)' : undefined}>
            <path d="M15.5 22.5 10 19.5C3 17 2.8 8 7 2" strokeWidth="1.2" />
            <g fill="currentColor" stroke="none">
                <path d="M5.8 5C5.4 2.7 7 .9 9 .5 8.8 2.8 7.6 4.4 5.8 5Z" />
                <path d="M4.5 8C2.6 6.8 2.3 4.7 3.1 3 4.8 4.4 5.4 6.3 4.5 8Z" />
                <path d="M4.1 9C4.4 6.8 6.2 5.6 8.1 5.5 7.5 7.6 6.1 8.8 4.1 9Z" />
                <path d="M4.2 12.5C1.8 11.8 1.1 9.9 1.4 8 3.5 8.8 4.6 10.5 4.2 12.5Z" />
                <path d="M4.8 14C4.2 11.8 5.4 10 7.2 9 7.6 11.3 6.8 13.1 4.8 14Z" />
                <path d="M6.4 17C3.9 17.1 2.2 15.7 1.8 13.8 4.2 13.8 5.9 15 6.4 17Z" />
                <path d="M8.7 18.5C6.7 17.3 6.3 15.2 7.1 13.3 9 14.7 9.7 16.7 8.7 18.5Z" />
                <path d="M11 20C8.8 21.6 6.4 21 5 19.3 7.4 18 9.4 18.2 11 20Z" />
            </g>
        </g>)}
    </g> : <path d={paths[kind]} />;
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{detail}</svg>;
}

InvitationIcon.propTypes = { kind: PropTypes.string.isRequired };

export default function HighRollersInvitation({ preview = false, onPreviewClose } = {}) {
    const { currentUser } = useContext(UserContext);
    const id = currentUser?.id;
    const [invitation, setInvitation] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!id || preview) return;
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
    }, [id, preview]);
    if (preview ? !currentUser?.isAdmin : !id || invitation?.id !== id) return null;
    async function respond(accept) {
        if (preview) { onPreviewClose?.(); return; }
        setBusy(true); setError('');
        try {
            const { error: failure } = await supabase.rpc('respond_high_rollers_invitation', { p_accept: accept, p_terms_version: invitation.version });
            if (failure) throw failure;
            setInvitation(null);
            window.dispatchEvent(new Event('khub:refresh-account'));
        } catch { setError('Could not save your response. Please try again or refresh.'); }
        finally { setBusy(false); }
    }
    return <div className="mmg-invitation-backdrop"><dialog open aria-modal="true" aria-labelledby="club-invite-title" className="mmg-invitation">
        {preview && <button type="button" onClick={onPreviewClose} aria-label="Close invitation preview" className="mb-2 block ml-auto text-xs underline">Close preview</button>}
        <header className="mmg-invitation-header"><InvitationIcon kind="crown" /><h2 id="club-invite-title">You&apos;ve Been Invited.</h2>
        <p>Someone has recommended you for induction into the <strong>MMG High Rollers Club</strong>.</p></header>
        <p className="mmg-invitation-acknowledgment">By accepting, you acknowledge:</p>
        <ul className="mmg-invitation-rules">
            <li><InvitationIcon kind="secrecy" /><div><strong>The first rule of MMG:</strong> You don&apos;t talk about MMG. Keep this club&apos;s existence, purpose, members, and activities hush-hush. Don&apos;t even ask others if they&apos;re members. I&apos;m serious.</div></li>
            <li><InvitationIcon kind="chance" /><div><strong>Fortune favors the bold.</strong> Games of chance carry risks. You participate voluntarily, accept potential losses, and agree not to be a baby about it.</div></li>
            <li><InvitationIcon kind="fairness" /><div><strong>Fair play is sacred.</strong> Every raffle uses public randomness, with independently verifiable winners and prizes.</div></li>
            <li><InvitationIcon kind="discretion" /><div><strong>What happens in MMG stays in MMG.</strong> You agree not to report the society solely for hosting games of chance in which you voluntarily participate.</div></li>
            <li><InvitationIcon kind="membership" /><div><strong>Membership is a privilege.</strong> Your membership may be revoked at any time, for any reason.</div></li>
        </ul>
        {error && <p role="alert" className="mmg-invitation-error">{error}</p>}
        <div className="mmg-invitation-actions"><button disabled={busy} onClick={() => respond(false)} className="mmg-invitation-decline">Decline</button><button autoFocus disabled={busy} onClick={() => respond(true)} className="mmg-invitation-accept">Accept Invitation</button></div>
    </dialog></div>;
}

HighRollersInvitation.propTypes = { preview: PropTypes.bool, onPreviewClose: PropTypes.func };
