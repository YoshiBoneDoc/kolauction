import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import useKolIdentity from '../hooks/useKolIdentity';
import { startPrivateRefresh } from '../lib/privateRefresh';
import CopyMessage from './CopyMessage';
import IgnoreList from './IgnoreList';

export default function KolVerification({ publicSellerHref }) {
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
        <header aria-label="Account overview" className="profile-panel profile-verification">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="flex min-w-0 flex-col items-start gap-0.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h2 className="break-words text-2xl font-bold leading-tight profile-text">{currentUser?.khubUsername}</h2>
                        {playerId && <span className="profile-verified-badge">Verified</span>}
                    </div>
                    {playerId && <p className="text-[13px] profile-muted">Player ID #{playerId}{identity.kol_player_name && identity.kol_player_name !== currentUser?.khubUsername && <> · {identity.kol_player_name}</>}</p>}
                    <nav aria-label="Profile links" className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {publicSellerHref && <Link to={publicSellerHref} className="profile-header-link profile-seller-link">Public seller profile</Link>}
                    </nav>
                </div>
                <nav aria-label="Account settings" className="flex shrink-0 flex-col items-start gap-2 self-start sm:items-end sm:self-center">
                    <Link to="/change-password" className="profile-header-link gap-2">
                        Change password
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="h-4 w-4">
                            <path d="m10 3-.5 2.5-2 1.2L5 6l-2 3.5 2 1.8v2.4l-2 1.8L5 19l2.5-.7 2 1.2.5 2.5h4l.5-2.5 2-1.2 2.5.7 2-3.5-2-1.8v-2.4l2-1.8L19 6l-2.5.7-2-1.2L14 3z" />
                            <circle cx="12" cy="12.5" r="3" />
                        </svg>
                    </Link>
                    {playerId && <IgnoreList />}
                </nav>
            </div>
            {!playerId && <section aria-label="KoL account linking" className="mt-3">
                <p className="mt-1.5 text-[13px] profile-muted">Link your account before listing or bidding. Send the code from this page by KMail from the KoL account you own.</p>
                <button onClick={request} disabled={pending || !supabase} className="profile-verification-button">{pending ? 'Creating code…' : challenge ? 'Get a new verification code' : 'Get verification code'}</button>
                {challenge && <div className="space-y-2"><p>KMail <strong>kHub (#3888760)</strong> with this exact message, attaching no Meat or items:</p><CopyMessage text={challenge.command} label="verification message" /><p>Valid for 20 minutes. This page checks for verification every 10 seconds while this tab is visible.</p></div>}
            </section>}
            {error && <p role="alert" className="profile-warning-text">{error}</p>}
        </header>
    );
}

KolVerification.propTypes = { publicSellerHref: PropTypes.string };
