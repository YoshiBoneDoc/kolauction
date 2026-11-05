// Temporary controlled-test visibility. Remove with the matching SQL policies.
export function canViewRaffles(user) {
    return !!user && (String(user.kolPlayerId) === '3552305'
        || ['anrath1', 'nisemono'].includes((user.kolPlayerName || '').toLowerCase()));
}
