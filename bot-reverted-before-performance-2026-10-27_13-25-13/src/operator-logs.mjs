import { readFileSync } from 'node:fs';
import { parseDocument, DomUtils } from 'htmlparser2';

// Message bodies appear only on failures, with credentials and verification tokens redacted.
// Player-controlled names cannot inject extra terminal lines or control sequences.
export const logText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 240);
// Keep the original player's text, not outgoing confirmation/credential messages.
export function failureBody(mail) {
    const raw = mail?.raw?.gift_original || mail?.raw || mail;
    if (typeof raw?.message !== 'string') return '[original message unavailable]';
    let text = DomUtils.textContent(parseDocument(raw.message.replace(/<br\s*\/?\s*>/gi, '\n')));
    if (['verify','register','credentials'].includes(mail?.command?.type)
        || /\b(?:VERIFY|REGISTER|CREDENTIALS|FORGOT\s+LOGIN)\b/i.test(text)) return '[account/verification message redacted]';
    for (const name of ['KOL_PASSWORD','SUPABASE_SERVICE_ROLE_KEY']) {
        const secret = process.env[name];
        if (secret) text = text.split(secret).join('[redacted]');
    }
    text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]')
        .replace(/\b(?:password|pwd|token|secret|api[_ -]?key)\s*[:=]\s*[^\s]+/gi, '[credential redacted]')
        .replace(/\bsb_secret_[A-Za-z0-9_-]+/g, '[secret key redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token redacted]');
    return text.length > 4000 ? text.slice(0,4000) + ' [truncated; full text retained in original KMail]' : text;
}
export function logMailFailure(log, mail, reason) {
    const raw = mail?.raw?.gift_original || mail?.raw || mail;
    const name = mail?.sender_name || raw?.fromname;
    const id = mail?.sender_id || raw?.fromid;
    log(`[MAIL CONTEXT KMail ${logText(mail?.id || raw?.id) || '?'}] ${logText(reason)} · From ${logText(name) || '[username unavailable]'} (#${logText(id) || '?'}) · Message: ${JSON.stringify(failureBody(mail))}`);
}
const number = value => /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('en-US') : '?';
let items = new Map();
try { items = new Map(JSON.parse(readFileSync(new URL('../catalog/items.json', import.meta.url), 'utf8')).map(item => [String(item.id), item.name])); }
catch { /* Logging falls back to item IDs; it must not prevent auction processing. */ }
export function assets(meat, attachments = []) {
    const parts = [];
    if (/^[0-9]+$/.test(String(meat)) && BigInt(meat) > 0n) parts.push(`${number(meat)} Meat`);
    for (const item of Array.isArray(attachments) ? attachments : []) {
        parts.push(`${number(item.quantity)} × ${logText(items.get(String(item.id)) || `item #${item.id}`)}`);
    }
    return parts.join('; ') || 'no attachments';
}
const purposes = {
    'donation-thanks': 'donation acknowledgment', 'donation-help': 'donation instructions',
    'bid-accepted': 'bid confirmation', activated: 'listing activation confirmation', outbid: 'outbid refund',
    excess: 'excess Meat refund', rejected: 'rejected deposit/bid refund', 'policy-refund': 'invalid mail refund',
    'sale-item': 'auction item delivery', 'sale-meat': 'seller payout', 'return-item': 'unsold item return',
    'buy-fill-payment': 'Buy order seller payment', 'buy-fill-accepted': 'fulfillment confirmation',
    'buy-fill-excess': 'excess fulfillment return', 'buy-fill-items': 'purchased item delivery',
    'buy-batch-items': 'purchased item delivery', 'buy-order-items': 'final purchased item delivery',
    'buy-order-refund': 'unused Buy order funds refund', 'buy-fund-excess': 'excess funding refund',
    'buy-funded': 'Buy order activation confirmation', 'buy-rejected': 'rejected Buy order deposit refund',
    'closet-review': 'closet-review admin alert', 'manual-review': 'manual-review alert',
    'delivery-preparation-review': 'delivery-review admin alert', 'mailbox-review-admin': 'delivery-review admin alert',
    'account-reply': 'account response', 'account-credentials': 'account credentials',
    'account-failure-player': 'account processing notice', 'account-failure-admin': 'account processing admin alert',
    verified: 'account linking confirmation', 'direct-trade-reminder': 'Direct Trade reminder',
    'bug-report': 'support notification', 'khub-bug-report': 'support notification', 'support-ticket': 'support notification',
};
export function deliveryPurpose(delivery) {
    return purposes[String(delivery.dedupe_key || '').split(':')[0]]
        || ({ refund: 'refund', sale_item: 'item delivery', sale_meat: 'seller payout', return_item: 'item return', notice: 'notification' })[delivery.kind] || 'message';
}
export const deliveryAssets = delivery => assets(delivery.meat, delivery.item_id && delivery.quantity ? [{id:delivery.item_id,quantity:delivery.quantity}] : []);
export const reference = (row, field = 'delivery_reference') => logText(row[field] || row.id);
export function auctionLabel(command = {}) {
    if (/^[1-9]\d*$/.test(String(command.auction_number))) return `Auction #${command.auction_number}`;
    if (/^[a-f0-9-]{36}$/i.test(String(command.auction_id))) return `Auction UUID ${command.auction_id}`;
    return '';
}
export function createOperatorLogs(log) {
    const seen = new Set(), players = new Map(), contexts = new Map();
    const bounded = (map, key, value) => { map.set(key, value); if (map.size > 2000) map.delete(map.keys().next().value); };
    const player = id => players.has(String(id)) ? `${players.get(String(id))} (#${id})` : `player #${logText(id) || '?'}`;
    function received(mail) {
        bounded(contexts, String(mail.id), {id:mail.id,sender_id:mail.sender_id,sender_name:mail.sender_name,
            raw:{message:failureBody(mail).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}});
        if (mail.sender_name) bounded(players, String(mail.sender_id), logText(mail.sender_name));
        if (seen.has(mail.id)) return;
        seen.add(mail.id); if (seen.size > 2000) seen.delete(seen.values().next().value);
        const command = ({bid:'BID',buy:'BUYOUT',list:'SELL DEPOSIT',fund:'BUY ORDER FUNDING',fill:'FULFILLMENT',donation:'DONATION',verify:'ACCOUNT VERIFICATION',register:'REGISTRATION',credentials:'ACCOUNT RECOVERY',bid_help:'BID HELP'})[mail.command?.type] || 'UNRECOGNIZED COMMAND';
        log(`[RECEIVED KMail ${logText(mail.id)}] ${command}${auctionLabel(mail.command) ? ` · ${auctionLabel(mail.command)}` : ''} from ${player(mail.sender_id)}: ${assets(mail.meat,mail.items)}.`);
    }
    function outcome(mail, result) {
        if (result === 'duplicate') return;
        const kind = ({bid:'BID',buy:'BUYOUT',list:'SELL DEPOSIT',fund:'BUY ORDER FUNDING',fill:'FULFILLMENT',donation:'DONATION',verify:'ACCOUNT VERIFICATION',bid_help:'BID HELP'})[mail.command?.type] || 'MAIL';
        const context = [auctionLabel(mail.command), player(mail.sender_id), `KMail ${logText(mail.id)}`].filter(Boolean).join(' · ');
        if (result === 'accepted') {
            // The attached amount may exceed a buyout or funding requirement.
            // Do not report it as the accepted amount or claim the auction is still active.
            log(`[${kind} ACCEPTED] ${context}.`);
        } else if (result === 'bid_help') {
            logMailFailure(log, mail, 'Bid instructions did not produce an accepted bid');
            log(`[BID HELP] ${context}: bidding instructions queued; no bid accepted.${BigInt(mail.meat || 0) > 0n || mail.items?.length ? ' Return of attached assets queued.' : ''}`);
        } else if (result === 'previous_donation_review') {
            logMailFailure(log, mail, 'Donation policy review');
            log(`[REVIEW] ${context}: previously classified as a donation; refund awaits asset reconciliation.`);
        } else if (typeof result === 'string' && result) {
            log(`[${kind} REJECTED] ${context}: ${logText(result)}${BigInt(mail.meat || 0) > 0n || mail.items?.length ? ' Return of attached assets queued.' : ''}`);
            logMailFailure(log, mail, 'Intake rejected');
        }
    }
    const failureForReceipt = (id, reason) => {
        if (!id) return;
        const context = contexts.get(String(id));
        if (context) logMailFailure(log, context, reason);
        else log(`[MAIL CONTEXT KMail ${logText(id)}] ${logText(reason)} · Original sender/message not cached in this worker session; inspect the receipt record.`);
    };
    return {received, outcome, player, failureForReceipt, failure: (mail, reason) => logMailFailure(log, mail, reason)};
}
