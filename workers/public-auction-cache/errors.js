// Only fixed operational categories cross the public API boundary. Never return
// upstream error messages, SQL, URLs, credentials, or arbitrary exception codes.
const codes = new Set([
    'CACHE_UNAVAILABLE', 'CACHE_CONFIG_URL', 'CACHE_CONFIG_KEY', 'CACHE_ORIGIN_AUTH',
    'CACHE_RPC_MISSING', 'CACHE_ORIGIN_PERMISSION', 'CACHE_ORIGIN_TIMEOUT',
    'CACHE_ORIGIN_ERROR', 'CACHE_INVALID_RESPONSE', 'CACHE_RESPONSE_TOO_LARGE',
    'CACHE_QUEUE_FULL', 'CACHE_CHANGED', 'CACHE_BINDING_MISSING', 'CACHE_BINDING_ERROR',
]);
export const safeCacheCode = value => codes.has(value) ? value : 'CACHE_UNAVAILABLE';
export const cacheFailure = (code = 'CACHE_UNAVAILABLE') => Object.assign(
    new Error('Public listings are temporarily busy. Please retry shortly.'),
    { status: 503, code: safeCacheCode(code) },
);
export const cacheErrorBody = code => ({ error: cacheFailure().message, code: safeCacheCode(code) });

export function originFailureCode(status, databaseCode) {
    if (databaseCode === 'PGRST202' || databaseCode === '42883' || status === 404) return 'CACHE_RPC_MISSING';
    if (databaseCode === '42501') return 'CACHE_ORIGIN_PERMISSION';
    if (status === 401 || status === 403) return 'CACHE_ORIGIN_AUTH';
    if (databaseCode === '57014' || status === 504) return 'CACHE_ORIGIN_TIMEOUT';
    return 'CACHE_ORIGIN_ERROR';
}
