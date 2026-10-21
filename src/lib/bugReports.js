export const BUG_REPORT_MAX_LENGTH = 2000;

function reportingError(error, administrator = false) {
    if (error.code === '42501' && administrator) return new Error('Administrator access required.');
    if (error.code === 'P0001') return new Error(error.message);
    return new Error(administrator ? 'The inbox is temporarily unavailable. Please try again later.' : 'Bug reporting is temporarily unavailable. Please try again later.');
}

export function createBugReportService(client) {
    async function rpc(name, params, administrator = false) {
        if (!client) throw new Error('Bug reporting is temporarily unavailable. Please try again later.');
        const { data, error } = await client.rpc(name, params);
        if (error) throw reportingError(error, administrator);
        return data;
    }
    return {
        async isAdministrator() { return await rpc('khub_is_administrator') === true; },
        async submit(requestId, body) {
            const text = body.trim();
            if (text.length < 10 || text.length > BUG_REPORT_MAX_LENGTH) throw new Error('Please describe the bug in 10 to 2,000 characters.');
            const data = await rpc('submit_bug_report', { p_request_id: requestId, p_body: text });
            if (!/^B-\d+$/.test(data?.reference || '')) throw new Error('The report response could not be confirmed. Please retry your submission.');
            return data;
        },
        async inbox(status = 'open', page = 1) {
            const data = await rpc('read_bug_report_inbox', { p_status: status, p_page: page }, true);
            if (!Array.isArray(data?.reports) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
                throw new Error('The inbox could not be loaded. Please try again.');
            }
            return { ...data, total: Number(data.total) };
        },
        async submitTradeReport(requestId, auctionId, body = '') {
            const text = body.trim();
            if (text.length > BUG_REPORT_MAX_LENGTH) throw new Error('Keep the optional explanation within 2,000 characters.');
            const data = await rpc('submit_trade_report', { p_request_id: requestId, p_auction_id: auctionId, p_body: text });
            if (!/^B-\d+$/.test(data?.reference || '')) throw new Error('The trade report response could not be confirmed. Please retry your submission.');
            return data;
        },
        async submitAppeal(requestId, body, image = null) {
            const text = body.trim();
            if (text.length < 10 || text.length > BUG_REPORT_MAX_LENGTH) throw new Error('Please describe your appeal in 10 to 2,000 characters.');
            const data = image
                ? await rpc('submit_ban_appeal_with_evidence', { p_request_id: requestId, p_body: text, p_image_base64: image.base64, p_mime_type: image.mime_type })
                : await rpc('submit_ban_appeal', { p_request_id: requestId, p_body: text });
            if (!/^B-\d+$/.test(data?.reference || '')) throw new Error('The appeal response could not be confirmed. Please retry your submission.');
            return data;
        },
        async readAppealEvidence(reportId) {
            return await rpc('read_appeal_evidence', { p_report_id: reportId }, true);
        },
        async supportInbox(category = 'all', status = 'open', page = 1) {
            const data = await rpc('read_support_inbox', { p_category: category, p_status: status, p_page: page }, true);
            if (!Array.isArray(data?.reports) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
                throw new Error('The inbox could not be loaded. Please try again.');
            }
            return { ...data, total: Number(data.total) };
        },
        async reviewTradeRating(reportId, counted, reason) {
            const text = reason.trim();
            if (text.length < 3 || text.length > 1000) throw new Error('Add a review reason in 3 to 1,000 characters.');
            await rpc('review_trade_rating', { p_report_id: reportId, p_counted: counted, p_reason: text }, true);
        },
        async supportThreads(category = 'all', status = 'open', page = 1) {
            const data = await rpc('read_support_threads', { p_category: category, p_status: status, p_page: page }, true);
            if (!Array.isArray(data?.threads) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) {
                throw new Error('The inbox could not be loaded. Please try again.');
            }
            return { ...data, total: Number(data.total) };
        },
        async updateSupportThread(threadId, isTrade, { status = null, category = null }) {
            await rpc('update_support_thread', { p_thread_id: threadId, p_is_trade: isTrade, p_status: status, p_category: category }, true);
        },
        async withdrawTradeRating(auctionId) {
            await rpc('withdraw_trade_rating', { p_auction_id: auctionId });
        },
        async submitTradeQuery(requestId, auctionId, body) {
            const text = body.trim();
            if (text.length < 10 || text.length > BUG_REPORT_MAX_LENGTH) throw new Error('Describe your trade query in 10 to 2,000 characters.');
            const data = await rpc('submit_trade_query', { p_request_id: requestId, p_auction_id: auctionId, p_body: text });
            if (!/^B-\d+$/.test(data?.reference || '')) throw new Error('The query response could not be confirmed. Please retry your submission.');
            return data;
        },
        async notifyAuctionRatings(auctionId) {
            const data = await rpc('notify_auction_ratings', { p_auction_id: auctionId }, true);
            if (!Number.isSafeInteger(data?.queued) || !Number.isSafeInteger(data?.remaining)) throw new Error('Rating notice status could not be confirmed. Refresh the inbox before trying again.');
            return data;
        },
        async setCategory(reportId, category) {
            await rpc('set_support_category', { p_report_id: reportId, p_category: category }, true);
        },
        async setStatus(reportId, status) {
            await rpc('set_bug_report_status', { p_report_id: reportId, p_status: status }, true);
        },
    };
}
