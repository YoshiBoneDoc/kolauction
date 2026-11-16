const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json = value => encode(new TextEncoder().encode(JSON.stringify(value)));

// Keep signing material exclusively in Worker secrets. Supabase is always called
// with the visitor's access token and publishable key, never a service-role key.
export async function onRequest({ request, env }, fetcher = fetch) {
    const reply = (error, status) => Response.json({ error }, { status, headers });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return reply('Login on khub first', 403);
    const authorization = request.headers.get('Authorization') || '';
    if (authorization.length > 16384 || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) return reply('Login on khub first', 401);
    const base = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const email = typeof env.GAME_FIREBASE_CLIENT_EMAIL === 'string' ? env.GAME_FIREBASE_CLIENT_EMAIL.trim() : '';
    const pem = env.GAME_FIREBASE_PRIVATE_KEY;
    const missing = [];
    if (!base) missing.push('SUPABASE_URL');
    if (!publishableKey) missing.push('SUPABASE_PUBLISHABLE_KEY');
    if (!email) missing.push('GAME_FIREBASE_CLIENT_EMAIL');
    if (!pem) missing.push('GAME_FIREBASE_PRIVATE_KEY');
    if (missing.length) return reply(`Game login: missing Worker runtime settings: ${missing.join(', ')}.`, 503);
    if (!email.endsWith('@mmo7-5864a.iam.gserviceaccount.com')) {
        return reply('Game login: GAME_FIREBASE_CLIENT_EMAIL must belong to Firebase project mmo7-5864a.', 503);
    }
    try {
        const url = new URL(base);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid configuration');
        const authHeaders = { apikey: publishableKey, Authorization: authorization, 'Content-Type': 'application/json' };
        const userResponse = await fetcher(`${url.origin}/auth/v1/user`, { headers: authHeaders, signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!userResponse.ok) return reply('Login on khub first', userResponse.status === 401 || userResponse.status === 403 ? 401 : 503);
        const user = await userResponse.json();
        if (!UUID.test(user?.id || '')) return reply('Login on khub first', 401);
        const profileResponse = await fetcher(`${url.origin}/rest/v1/rpc/read_my_account_access`, {
            method: 'POST', headers: authHeaders, body: '{}', signal: AbortSignal.timeout(8000), redirect: 'error',
        });
        if (!profileResponse.ok) return reply('Your khub account could not be checked. Please try again.', 503);
        const profile = await profileResponse.json();
        if (profile?.id !== user.id || typeof profile.is_banned !== 'boolean') return reply('Your khub account could not be checked. Please try again.', 503);
        if (profile.is_banned) return reply('Your khub account cannot enter the game.', 403);
        const username = profile.khub_username;
        if (typeof username !== 'string' || username !== username.trim() || !username.length || username.length > 16 || [...username].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
            return reply('Your khub username could not be loaded. Please contact support.', 409);
        }
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: email, sub: email,
            aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
            iat: now, exp: now + 300, uid: `khub:${user.id}`,
            claims: { khub_user_id: user.id, khub_username: username },
        };
        const keyBytes = Uint8Array.from(atob(pem.replace(/\\n/g, '\n')
            .replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('pkcs8', keyBytes,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        const unsigned = `${json({ alg: 'RS256', typ: 'JWT' })}.${json(payload)}`;
        const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
        return Response.json({ customToken: `${unsigned}.${encode(signature)}` }, { headers });
    } catch {
        // Never include upstream response bodies, JWTs, signing keys or raw errors.
        return reply('Game login is temporarily unavailable. Please try again.', 503);
    }
}
