import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { readBarter, invalidateBarter } from '../lib/barter';

export default function useBarterRead(name, args = {}, enabled = true) {
    const { currentUser } = useContext(UserContext);
    const scope = `${currentUser?.id || 'guest'}:${Boolean(currentUser?.isBanned)}`;
    const key = JSON.stringify([scope, name, args]);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState(null);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        let pending = false;
        async function update() {
            if (pending || document.visibilityState === 'hidden') return;
            pending = true;
            try {
                const data = await readBarter(scope, name, JSON.parse(key)[2]);
                if (!cancelled) setResult({ key, data });
            } catch (error) { if (!cancelled) setResult(previous => ({ key, data: previous?.key === key ? previous.data : undefined, error: error.message })); }
            finally { pending = false; }
        }
        update();
        const timer = setInterval(update, 30000);
        globalThis.addEventListener('barter-updated', update);
        document.addEventListener('visibilitychange', update);
        return () => { cancelled = true; clearInterval(timer); globalThis.removeEventListener('barter-updated', update); document.removeEventListener('visibilitychange', update); };
    }, [key, scope, name, enabled, attempt]);
    return { data: enabled && result?.key === key ? result.data : undefined,
        error: enabled && result?.key === key ? result.error : null,
        refresh() { invalidateBarter(); setAttempt(value => value + 1); } };
}
