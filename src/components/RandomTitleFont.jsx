import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fontCatalog, loadTitleFont, randomFamily } from '../lib/randomTitleFont';

export default function RandomTitleFont({ titleRef, heartedFonts, onHeart }) {
    const [history, setHistory] = useState(['Newsreader']);
    const [favorites, setFavorites] = useState(() => {
        try { const saved = JSON.parse(localStorage.getItem('khub.title-font-favorites.v1') || '[]'); return Array.isArray(saved) ? [...new Set(saved.filter(name => typeof name === 'string' && name.length <= 200))] : []; } catch { return []; }
    });
    useEffect(() => {
        try { localStorage.setItem('khub.title-font-favorites.v1', JSON.stringify(favorites)); } catch { /* Optional local preference. */ }
    }, [favorites]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const activeLink = useRef(null);
    const working = useRef(false);
    const current = history[history.length - 1];
    useEffect(() => () => {
        generation.current++;
        activeLink.current?.remove();
        titleRef.current?.style.removeProperty('font-family');
        titleRef.current?.style.removeProperty('font-weight');
    }, [titleRef]);
    async function preview(mode, favorite) {
        if (working.current) return;
        working.current = true; setBusy(true); setError('');
        const request = ++generation.current;
        try {
            let family, link;
            const failed = new Set([current]);
            for (let attempt = 0; attempt < (mode === 'random' ? 4 : 1); attempt++) {
                family = mode === 'favorite' ? favorite : mode === 'reset' ? 'Newsreader' : mode === 'previous' ? history[history.length - 2]
                    : randomFamily((await fontCatalog()).filter(name => !failed.has(name)), current);
                if (!family) throw new Error('No fonts available');
                try { link = family === 'Newsreader' ? null : await loadTitleFont(family); break; }
                catch (failure) { failed.add(family); if (attempt === (mode === 'random' ? 3 : 0)) throw failure; }
            }
            if (generation.current !== request) { link?.remove(); return; }
            activeLink.current?.remove(); activeLink.current = link;
            if (titleRef.current) {
                titleRef.current.style.fontFamily = JSON.stringify(family);
                titleRef.current.style.fontWeight = family === 'Newsreader' ? '500' : '400';
            }
            setHistory(previous => mode === 'reset' ? ['Newsreader'] : mode === 'previous' ? previous.slice(0, -1) : [...previous, family]);
        } catch { if (generation.current === request) setError('Font unavailable. Please try again.'); }
        finally { working.current = false; if (generation.current === request) setBusy(false); }
    }
    const saved = (heartedFonts || favorites).includes(current);
    async function heart() {
        if (working.current) return;
        working.current = true; setBusy(true); setError('');
        try {
            if (onHeart) await onHeart(current, !saved);
            setFavorites(previous => saved ? previous.filter(name => name !== current) : [...new Set([...previous, current])]);
        } catch { setError('Heart could not be confirmed. Please try again.'); }
        finally { working.current = false; setBusy(false); }
    }
    const iconClass = 'inline-flex h-6 w-6 shrink-0 border-0 bg-transparent p-0 items-center justify-center rounded title-font-control focus-visible:outline focus-visible:outline-1 disabled:opacity-30';
    return <div className="title-font-toolbar absolute right-0 top-0 z-10 flex max-w-full items-center gap-0.5 text-[10px]">
        <span aria-live="polite" title={current} className="mr-1 min-w-0 max-w-[min(40vw,180px)] truncate text-[10px]">{busy ? 'Loading…' : current}</span>
        <button type="button" title="Random font" aria-label="Random font" disabled={busy} onClick={() => preview('random')} className={iconClass}>
            <svg className="shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-3 6-6s4-6 6-6h3m-4-4 4 4-4 4" /></svg>
        </button>
        <button type="button" title="Previous font" aria-label="Previous font" disabled={busy || history.length < 2} onClick={() => preview('previous')} className={iconClass}>←</button>
        <button type="button" title={saved ? 'Remove favorite' : 'Favorite font'} aria-label={saved ? 'Remove favorite' : 'Favorite font'} aria-pressed={saved} disabled={busy}
            onClick={heart} className={iconClass}>
            <svg className="shrink-0" width="13" height="13" viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg>
        </button>
        <button type="button" title="Restore Newsreader" aria-label="Restore Newsreader" disabled={busy || history.length < 2} onClick={() => preview('reset')} className={iconClass}>↺</button>
        {error && <span role="status" className="absolute right-0 top-full w-52 text-right text-[10px]">{error}</span>}
    </div>;
}
RandomTitleFont.propTypes = { heartedFonts: PropTypes.arrayOf(PropTypes.string), onHeart: PropTypes.func, titleRef: PropTypes.shape({ current: PropTypes.object }).isRequired };
