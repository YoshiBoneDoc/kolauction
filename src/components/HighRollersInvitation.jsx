import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import './HighRollersInvitation.css';
import PropTypes from 'prop-types';

function InvitationIcon({ kind }) {
    const paths = {
        crown: 'm3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm3 10h12',
        secrecy: 'M8 11V7a4 4 0 0 1 8 0v4M6 11h12v10H6V11Zm6 4v2',
        chance: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 4h.01M12 12h.01M17 17h.01M7 17h.01M17 7h.01',
        fairness: 'M12 3v18M5 21h14M4 6h16M6 6l-4 8h8L6 6Zm12 0-4 8h8l-4-8',
        discretion: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-3 9 2 2 4-4',
        membership: 'M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0ZM4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
    };
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>;
}

InvitationIcon.propTypes = { kind: PropTypes.string.isRequired };

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
    return <div className="mmg-invitation-backdrop"><dialog open aria-modal="true" aria-labelledby="club-invite-title" className="mmg-invitation">
        <header className="mmg-invitation-header"><InvitationIcon kind="crown" /><h2 id="club-invite-title">You&apos;ve Been Invited.</h2>
        <p>Someone has recommended you for induction into the <strong>MMG High Rollers Club</strong>.</p></header>
        <p className="mmg-invitation-acknowledgment">By accepting, you acknowledge:</p>
        <ul className="mmg-invitation-rules">
            <li><InvitationIcon kind="secrecy" /><div><strong>The first rule of MMG:</strong> You don&apos;t talk about MMG. Keep this club&apos;s existence, purpose, members, and activities hush-hush. Don&apos;t even ask others if they&apos;re members. I&apos;m serious.</div></li>
            <li><InvitationIcon kind="chance" /><div><strong>Fortune favors the bold.</strong> Games of chance carry risks. You participate voluntarily, accept potential losses, and agree not to be a baby about it.</div></li>
            <li><InvitationIcon kind="fairness" /><div><strong>Fair play is sacred.</strong> You retain the right to request proof of a provably fair outcome for any game you&apos;ve participated in.</div></li>
            <li><InvitationIcon kind="discretion" /><div><strong>What happens in MMG stays in MMG.</strong> You agree not to report the society solely for hosting games of chance in which you voluntarily participate.</div></li>
            <li><InvitationIcon kind="membership" /><div><strong>Membership is a privilege.</strong> Your membership may be revoked at any time, for any reason.</div></li>
        </ul>
        {error && <p role="alert" className="mmg-invitation-error">{error}</p>}
        <div className="mmg-invitation-actions"><button disabled={busy} onClick={() => respond(false)} className="mmg-invitation-decline">Decline</button><button autoFocus disabled={busy} onClick={() => respond(true)} className="mmg-invitation-accept">Accept Invitation</button></div>
    </dialog></div>;
}
