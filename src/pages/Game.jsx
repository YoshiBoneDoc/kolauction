import { useContext, useEffect, useRef, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createGameLoginBridge } from '../lib/gameLogin';

export default function Game() {
    const { currentUser } = useContext(UserContext);
    const frame = useRef(null);
    const configuredUrl = import.meta.env.VITE_GAME_URL || '';
    const [loginMessage, setLoginMessage] = useState('');
    const url = new URL(configuredUrl, window.location.origin);
    const userId = currentUser?.id || null;
    const validUrl = Boolean(configuredUrl) && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    useEffect(() => {
        if (!validUrl || !frame.current) return;
        return createGameLoginBridge({
            frame: frame.current, gameOrigin: url.origin, userId,
            getSession: () => supabase ? supabase.auth.getSession() : Promise.resolve({ data: { session: null } }),
        });
    }, [userId, url.origin, validUrl]);
    if (!validUrl) return <main className="mx-auto my-10 w-full max-w-sm rounded-xl border border-slate-600 bg-[#252a34] p-8 text-center text-white">
        <h1 className="mb-6 text-2xl font-semibold">Login on khub first</h1>
        <button type="button" className="w-full rounded border border-[#5684b8] bg-[#426b9b] p-3 font-semibold"
            onClick={() => setLoginMessage('Game login is temporarily unavailable. Please try again.')}>Login</button>
        {loginMessage && <p className="mt-4" role="status">{loginMessage}</p>}
    </main>;
    return <main className="mx-auto w-full max-w-7xl px-2 py-4 sm:px-6">
        <iframe key={userId || 'guest'} ref={frame} src={url.href} title="khubMMO"
            allow="fullscreen" referrerPolicy="same-origin"
            className="w-full rounded-xl border border-slate-600 bg-[#20242d]"
            style={{ height: 'min(80vh, 850px)', minHeight: 480 }} />
    </main>;
}
