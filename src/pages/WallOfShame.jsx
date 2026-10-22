import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { loadWallOfShame, WALL_PAGE_SIZE } from '../lib/wallOfShame';

const portrait = '/art/wall-of-shame-watercolor.png';
const date = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function BanPortrait({ entry, showIdentity = false }) {
    return (
        <article className="shame-exhibit" aria-labelledby={`ban-${entry.id}`}>
            <div className="shame-frame">
                <div className="shame-mat"><img src={portrait} alt="" loading="lazy" width="1024" height="1024" /></div>
            </div>
            <div className="shame-nameplate">
                <p className="shame-status">{entry.expires_at ? 'Temporary ban' : 'Permanent ban'}</p>
                <h2 id={`ban-${entry.id}`}>{showIdentity ? entry.kol_player_name : 'Banned player'}</h2>
                {showIdentity && entry.kol_player_id && <p className="shame-player">KoL #{entry.kol_player_id}</p>}
                <p className="shame-reason">{showIdentity ? entry.public_reason : 'Log in with an unrestricted account to view this reviewed ban.'}</p>
                <p className="shame-dates">Banned <time dateTime={entry.banned_at}>{date(entry.banned_at)}</time>
                    {entry.expires_at && <> · Until <time dateTime={entry.expires_at}>{date(entry.expires_at)}</time></>}</p>
            </div>
        </article>
    );
}
BanPortrait.propTypes = { showIdentity: PropTypes.bool, entry: PropTypes.shape({
    id: PropTypes.string.isRequired, kol_player_name: PropTypes.string.isRequired,
    kol_player_id: PropTypes.number, public_reason: PropTypes.string.isRequired,
    banned_at: PropTypes.string.isRequired, expires_at: PropTypes.string,
}).isRequired };

export default function WallOfShame() {
    const { currentUser } = useContext(UserContext);
    const [page, setPage] = useState(0);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        let cancelled = false;
        setResult(null);
        setError('');
        loadWallOfShame(supabase, page).then(data => {
            if (!cancelled) setResult(data);
        }).catch(failure => {
            if (!cancelled) setError(failure.message);
        });
        return () => { cancelled = true; };
    }, [page, attempt, currentUser?.id]);

    return (
        <div className="shame-page">
            <main className="shame-gallery">
                <header className="shame-heading">
                    <p className="shame-eyebrow">The kHub</p>
                    <h1>Wall of Shame</h1>
                    <p>A permanent tribute to exceptionally poor judgment.</p>
                    <span className="shame-divider" aria-hidden="true">✦</span>
                </header>
                {error ? <div className="shame-notice" role="alert">
                    <p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button>
                </div> : !result ? <p className="shame-notice" role="status">Opening the gallery…</p>
                    : result.entries.length ? <>
                        <div className="shame-wall">{result.entries.map(entry => <BanPortrait key={entry.id} entry={entry} showIdentity={Boolean(currentUser && !currentUser.isBanned && result.usernames_visible !== false)} />)}</div>
                        {(page > 0 || (page + 1) * WALL_PAGE_SIZE < result.total) && <nav className="shame-pagination" aria-label="Gallery pages">
                            <button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button>
                            <span>Page {page + 1}</span>
                            <button disabled={(page + 1) * WALL_PAGE_SIZE >= result.total} onClick={() => setPage(value => value + 1)}>Next</button>
                        </nav>}
                    </> : <div className="shame-empty">
                        <div className="shame-exhibit shame-empty-frame" aria-hidden="true"><div className="shame-frame"><div className="shame-mat"><img src={portrait} alt="" width="1024" height="1024" /></div></div></div>
                        <h2>{page ? 'No more portraits.' : 'No portraits yet. We’d prefer to keep it that way.'}</h2>
                        <p>{page ? 'The collection may have changed since your last visit.' : 'No current bans have been published.'}</p>
                        {page > 0 && <button onClick={() => setPage(0)}>Back to the first page</button>}
                    </div>}
                <footer className="shame-footer">
                    <p>Only bans upheld after review are displayed.</p>
                    <p>Believe a ban is in error? <Link to="/submit-appeal">Submit an appeal</Link></p>
                </footer>
            </main>
        </div>
    );
}
