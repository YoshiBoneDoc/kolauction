export function createSiteBannerService(client, { publicRead = null } = {}) {
    async function call(name, args) {
        if (!client) throw new Error('Site announcements are temporarily unavailable.');
        const { data, error } = await client.rpc(name, args);
        if (error) throw new Error(error.message || 'The announcement could not be saved. Please try again.');
        return data;
    }
    return {
        read: () => publicRead ? publicRead() : call('read_site_banner'),
        manage: () => call('read_admin_site_banner'),
        save: (message, active) => call('save_site_banner', { p_message: message, p_active: active }),
    };
}

// Keep one dismissal, so older messages do not accumulate in browser storage.
const dismissalKey = 'khub.dismissed-site-banner';
export function readBannerDismissal(storage) {
    try { return storage.getItem(dismissalKey); } catch { return null; }
}
export function dismissBanner(storage, revision) {
    try { storage.setItem(dismissalKey, revision); } catch { /* Dismissal still works in memory. */ }
}
