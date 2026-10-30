import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import useKolIdentity from '../hooks/useKolIdentity';
import { startPrivateRefresh } from '../lib/privateRefresh';
import CopyMessage from './CopyMessage';
import IgnoreList from './IgnoreList';

export default function KolVerification() {
    const { currentUser } = useContext(UserContext);
    const identity = useKolIdentity();
    const [challenge, setChallenge] = useState(null);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const playerId = identity?.kol_player_id;
    useEffect(() => {
        if (!challenge || playerId || !currentUser?.id) return;
        // Only an active verification challenge needs faster checks. The shared
        // account scheduler still deduplicates and backs off database failures.
        return startPrivateRefresh({ refresh: () => window.dispatchEvent(new Event('khub:refresh-account')),
            document, window, interval: 10000 });
    }, [challenge, playerId, currentUser?.id]);
    async function request() {
        if (!supabase || pending) return;
        setPending(true); setError('');
        const { data, error } = await supabase.rpc('request_kol_verification');
        if (error) setError(error.message); else setChallenge(data);
        setPending(false);
    }
    return (
        <section aria-label="KoL account linking" className="profile-panel profile-verification">
            <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-[15px] font-semibold profile-text">Your KoL account</h2>
                {identity?.kol_player_id && <span className="profile-verified-badge">Verified</span>}
            </div>
            {identity?.kol_player_id ? <div className="mt-1.5 flex flex-wrap items-center gap-3"><p className="text-[13px] profile-muted">{identity.kol_player_name} (#{identity.kol_player_id}) · Auction escrow uses this player ID.</p><IgnoreList /></div> : <>
                <p className="mt-1.5 text-[13px] profile-muted">Link your account before listing or bidding. Send the code from this page by KMail from the KoL account you own.</p>
                <button onClick={request} disabled={pending || !supabase} className="profile-verification-button">{pending ? 'Creating code…' : challenge ? 'Get a new verification code' : 'Get verification code'}</button>
                {challenge && <div className="space-y-2"><p>KMail <strong>kHub (#3888760)</strong> with this exact message, attaching no Meat or items:</p><CopyMessage text={challenge.command} label="verification message" /><p>Valid for 20 minutes. This page checks for verification every 10 seconds while this tab is visible.</p></div>}
            </>}
            {error && <p role="alert" className="profile-warning-text">{error}</p>}
        </section>
    );
}
