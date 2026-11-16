export function createGameLoginBridge({ frame, gameOrigin, getSession, userId, host = window, fetcher = fetch }) {
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    const receive = async event => {
        if (disposed || pending || event.source !== frame.contentWindow || event.origin !== gameOrigin ||
            event.data?.type !== 'khub:game-login' ||
            !/^[0-9a-f-]{36}$/i.test(event.data.requestId || '')) return;
        pending = true;
        const requestId = event.data.requestId;
        const reply = result => {
            if (!disposed) frame.contentWindow?.postMessage({ type: 'khub:game-login-result', requestId, ...result }, gameOrigin);
        };
        try {
            const { data, error } = await getSession();
            const session = data?.session;
            if (disposed) return;
            if (error || !userId || session?.user?.id !== userId || !session?.access_token) {
                reply({ error: 'Login on khub first' });
                return;
            }
            const response = await fetcher('/api/game-login', {
                method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` },
                cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            });
            const result = await response.json();
            if (!response.ok || typeof result.customToken !== 'string') {
                reply({ error: typeof result.error === 'string' ? result.error : 'Game login is temporarily unavailable.' });
                return;
            }
            reply({ customToken: result.customToken });
        } catch {
            reply({ error: 'Game login is temporarily unavailable. Please try again.' });
        } finally { pending = false; }
    };
    host.addEventListener('message', receive);
    return () => {
        disposed = true;
        controller.abort();
        host.removeEventListener('message', receive);
    };
}
