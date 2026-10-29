export async function readPublicBanner({ fetch: fetcher = globalThis.fetch } = {}) {
    const response = await fetcher('/api/public-banner', { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Announcement temporarily unavailable.');
    const data = await response.json();
    if (data?.shared_cache_version !== 1 || data?.privacy_version !== 1
        || (data.banner !== null && (!data.banner || typeof data.banner.revision !== 'string' || typeof data.banner.message !== 'string'))) {
        throw new Error('Announcement could not be verified.');
    }
    return data.banner;
}
