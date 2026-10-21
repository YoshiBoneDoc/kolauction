const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
export function validateAppealImage(file) {
    if (!file || !imageTypes.has(file.type) || file.size < 1 || file.size > 2 * 1024 * 1024) {
        throw new Error('Choose a PNG, JPEG or WebP image up to 2 MB.');
    }
}
export function evidenceDataUrl(data) {
    if (!imageTypes.has(data?.mime_type) || typeof data?.base64 !== 'string' || data.base64.length > 2796204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64)) {
        throw new Error('The evidence image could not be loaded.');
    }
    return `data:${data.mime_type};base64,${data.base64}`;
}
export function countdown(expiresAt, now) {
    const remaining = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
    if (!Number.isFinite(remaining) || remaining === 0) return 'Checking account status…';
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor(remaining % 86400 / 3600);
    const minutes = Math.floor(remaining % 3600 / 60);
    const seconds = remaining % 60;
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s`;
}
export function readImage(file) {
    validateAppealImage(file);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The image could not be read. Please choose it again.'));
        reader.onload = () => resolve({ mime_type: file.type, base64: String(reader.result).split(',')[1] });
        reader.readAsDataURL(file);
    });
}
export function createAccountRestrictionService(client) {
    async function rpc(name, params) {
        if (!client) throw new Error('Account controls are temporarily unavailable.');
        const { data, error } = await client.rpc(name, params);
        if (error) throw new Error(error.code === '42501' ? 'Administrator access required.' : error.code === 'P0001' ? error.message : 'Account controls are temporarily unavailable. Please retry.');
        return data;
    }
    return {
        async appealHistory(reportId) {
            const data = await rpc('read_appeal_ban_history', { p_report_id: reportId });
            if (!Array.isArray(data) || data.some(event => typeof event.id !== 'string'
                || !['issued', 'updated', 'removed'].includes(event.action)
                || !Number.isFinite(Date.parse(event.created_at)) || typeof event.reason !== 'string')) {
                throw new Error('Ban history could not be loaded. Please retry.');
            }
            return data;
        },
        async reportAccount(reportId) {
            const data = await rpc('read_appeal_account', { p_report_id: reportId });
            if (data === null) return null;
            if (!data || typeof data.id !== 'string' || typeof data.is_banned !== 'boolean') throw new Error('The account could not be loaded. Please retry.');
            return data;
        },
        async auctions() {
            const data = await rpc('read_auction_ban_reviews', {});
            if (!Array.isArray(data)) throw new Error('Auction reviews could not be loaded.');
            return data;
        },
        async reviewAuction(auctionId, action, reason) {
            await rpc('review_banned_auction', { p_auction_id: auctionId, p_action: action, p_reason: reason.trim() });
        },
        async search(search) {
            const data = await rpc('read_admin_accounts', { p_search: search.trim() });
            if (!Array.isArray(data)) throw new Error('Accounts could not be loaded.');
            return data;
        },
        async save(userId, reason, expiresAt = null) {
            if (reason.trim().length < 3 || reason.trim().length > 1000) throw new Error('Add a reason in 3 to 1,000 characters.');
            if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error('Choose a future expiry.');
            await rpc('set_account_restriction', { p_user_id: userId, p_reason: reason.trim(), p_expires_at: expiresAt });
        },
        async lift(userId, reason) {
            if (reason.trim().length < 3 || reason.trim().length > 1000) throw new Error('Add a reason in 3 to 1,000 characters.');
            await rpc('lift_account_restriction', { p_user_id: userId, p_reason: reason.trim() });
        },
    };
}
