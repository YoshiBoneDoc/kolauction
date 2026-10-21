import { tradeResponseStatus } from './tradeResponses.js';

export const supportCategories = [['bug', 'Bug reports'], ['trade', 'Trade queries'], ['appeal', 'Ban appeals'], ['other', 'Other']];

export function formatSupportTimestamp(value) {
    return new Date(value).toLocaleString('en-US', {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

export function threadKey(thread) {
    return `${thread.is_trade ? 'trade' : 'message'}-${thread.id}`;
}

export function threadRoleStatus(thread, role) {
    const participant = thread.auction?.[role];
    if (thread.auction?.escrow) return { label: 'Escrow', color: 'text-slate-500' };
    return tradeResponseStatus({
        confirmedAt: participant?.confirmed_at, resolvedAt: participant?.resolved_at,
        reportedIncomplete: thread.messages.some(message => message.reporter_role === role && message.message_type === 'trade_rating' && !message.feedback_withdrawn && message.negative_counted !== false),
        reportExcluded: thread.messages.some(message => message.reporter_role === role && message.message_type === 'trade_rating' && !message.feedback_withdrawn && message.negative_counted === false),
    });
}


// Withdrawal updates are durable report history, rendered once alongside the
// original messages. They never create another report or change its category.
export function supportTimeline(thread, banEvents = []) {
    const entries = thread.messages.flatMap(message => {
        if (message.message_type !== 'trade_rating' || !message.feedback_withdrawn) return [message];
        const resolvedAt = thread.auction?.[message.reporter_role]?.resolved_at;
        return [message, {
            ...message,
            id: `withdrawal-${message.id}`,
            message_type: 'trade_resolution',
            created_at: message.withdrawn_at || resolvedAt || null,
            withdrawal_confirmed_complete: message.withdrawal_confirmed_complete ?? Boolean(resolvedAt),
        }];
    });
    entries.push(...banEvents.map(event => ({ ...event, message_type: 'account_ban_event' })));
    const timestamp = entry => entry.created_at ? new Date(entry.created_at).getTime() : -Infinity;
    return entries.sort((a, b) => timestamp(b) - timestamp(a));
}
