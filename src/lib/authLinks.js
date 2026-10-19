export function getAuthRedirectUrls(origin) {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid website address.');
    return {
        confirmation: new URL('/auth/confirm', base.origin).href,
        recovery: new URL('/reset-password', base.origin).href,
    };
}

// Capture URL errors before the SDK consumes and removes authentication hashes.
export function readAuthLink(location) {
    const query = new URLSearchParams(location?.search || '');
    const hash = new URLSearchParams((location?.hash || '').replace(/^#/, ''));
    const value = (name) => hash.get(name) || query.get(name);
    return {
        type: value('type'),
        accessToken: value('access_token'),
        error: ['error', 'error_code', 'error_description'].some((name) => value(name))
            ? 'This email link is invalid or expired. Please request a new one.' : '',
    };
}

export function recoveryUserForEvent(event, session, savedUserId, initialLink) {
    if (!session || event === 'SIGNED_OUT' || initialLink.error) return null;
    const fromRecoveryLink = initialLink.type === 'recovery'
        && initialLink.accessToken && initialLink.accessToken === session.access_token;
    if (event === 'PASSWORD_RECOVERY' || (event === 'INITIAL_SESSION' && fromRecoveryLink)) return session.user.id;
    // A token refresh or refocus should not interrupt an unfinished reset.
    return savedUserId === session.user.id ? savedUserId : null;
}
