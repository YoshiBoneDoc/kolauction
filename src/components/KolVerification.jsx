import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import CopyMessage from './CopyMessage';

export default function KolVerification() {
    const { currentUser } = useContext(UserContext);
    const [identity, setIdentity] = useState(null);
    const [challenge, setChallenge] = useState(null);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    useEffect(() => {
        if (!supabase || !currentUser) return;
        let cancelled = false;
        async function refresh() {
            const { data, error } = await supabase.from('profiles').select('kol_player_id,kol_player_name').eq('id', currentUser.id).single();
            if (cancelled) return;
            if (error) setError('KoL account linking requires the KMail escrow database migration.');
            else { setIdentity(data); setError(''); }
        }
        refresh();
        const timer = setInterval(refresh, 10000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [currentUser]);
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
            {identity?.kol_player_id ? <p className="mt-1.5 text-[13px] profile-muted">{identity.kol_player_name} (#{identity.kol_player_id}) · Auction escrow uses this player ID.</p> : <>
                <p className="mt-1.5 text-[13px] profile-muted">Link your account before listing or bidding. Send the code from this page by KMail from the KoL account you own.</p>
                <button onClick={request} disabled={pending || !supabase} className="profile-verification-button">{pending ? 'Creating code…' : challenge ? 'Get a new verification code' : 'Get verification code'}</button>
                {challenge && <div className="space-y-2"><p>KMail <strong>kHub (#3888760)</strong> with this exact message, attaching no Meat or items:</p><CopyMessage text={challenge.command} label="verification message" /><p>Valid for 20 minutes. This page checks for verification every 10 seconds while the bot is running.</p></div>}
            </>}
            {error && <p role="alert" className="profile-warning-text">{error}</p>}
        </section>
    );
}
