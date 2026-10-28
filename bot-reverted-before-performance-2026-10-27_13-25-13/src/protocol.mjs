export class MailDeliveryError extends Error {
    constructor(reason, hash = null, diagnostic = null) {
        super('KoL did not provide the expected send acknowledgment; no automatic retry.');
        this.diagnostic = diagnostic;
        this.evidence = reason === 'request_failed'
            ? 'Regular KMail request failed or timed out before acknowledgment; no gift attempted. Check the sent-copy reference before reconciling; no automatic resend.'
            : `Regular KMail returned an unrecognized response; no gift attempted. Response SHA256 ${hash}. Check the sent-copy reference before reconciling; no automatic resend.`;
        if (diagnostic) this.evidence += ` Safe response diagnostic: ${JSON.stringify(diagnostic)}`;
    }
}

export class GiftDeliveryError extends Error {
    constructor(outcome = 'uncertain') {
        super(outcome === 'not_attempted'
            ? 'gift not attempted because its funds or rollover check did not pass.'
            : 'Gift package outcome uncertain; inspect recipient gift packages before any retry.');
        this.outcome = outcome === 'not_attempted' ? outcome : 'uncertain';
    }
}

export class GiftBudgetDeferredError extends Error {
    constructor() { super('Buy gift delivery is safely held until kHub can cover packaging from spare funds.'); }
}

export const BOT_ID = 3888760;
export const BOT_NAME = 'kHub';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function parseCommand(text) {
    const value = text.trim();
    if (/^register$/i.test(value)) return { type: 'register' };
    if (/^register\s/i.test(value)) return { type: 'register', invalid_format: true };
    if (/^(credentials|forgot login)$/i.test(value)) return { type: 'credentials' };
    if (/^donate$/i.test(value)) return { type: 'donation' };
    const verification = value.match(/^verify\s+([0-9a-f]{32})$/i);
    if (verification) return { type: 'verify', token: verification[1].toLowerCase() };
    const reservedFill = value.match(new RegExp(`^fill\\s+(#?[1-9][0-9]{0,18}|${uuid})\\s+(${uuid})$`, 'i'));
    if (reservedFill) {
        const target = reservedFill[1].replace(/^#/, '').toLowerCase();
        if (/^[0-9]+$/.test(target) && BigInt(target) > 9223372036854775807n) return { type: 'unknown' };
        return { type: 'fill', ...(/^[0-9]+$/.test(target) ? { auction_number: target } : { auction_id: target }), reservation_id: reservedFill[2].toLowerCase() };
    }
    const shortCommand = value.match(/^(?:(list|bid|buy|fund|fill)\s+)?#?([1-9][0-9]{0,18})$/i);
    if (shortCommand && BigInt(shortCommand[2]) <= 9223372036854775807n) {
        return { type: shortCommand[1]?.toLowerCase() || 'bid', auction_number: shortCommand[2] };
    }
    const command = value.match(new RegExp(`^(list|bid|buy|fund|fill)\\s+(${uuid})$`, 'i'));
    if (command) return { type: command[1].toLowerCase(), auction_id: command[2].toLowerCase() };
    if (new RegExp(`^${uuid}$`, 'i').test(value)) return { type: 'bid', auction_id: value.toLowerCase() };
    // A typed amount is not an attachment. Recognize this common mistake only
    // to send instructions; it must never enter the funded bidding path.
    const mistakenBid = value.match(new RegExp(`^bid\\s+(#?[1-9][0-9]{0,18}|${uuid})\\s+[0-9][0-9,.]*(?:[kmb])?(?:\\s+meat)?$`, 'i'));
    if (mistakenBid) {
        const target = mistakenBid[1].replace(/^#/, '').toLowerCase();
        if (!/^[0-9]+$/.test(target) || BigInt(target) <= 9223372036854775807n) {
            return { type: 'bid_help', ...(/^[0-9]+$/.test(target) ? { auction_number: target } : { auction_id: target }) };
        }
    }
    return { type: 'unknown' };
}

export function whole(value, label, max = Number.MAX_SAFE_INTEGER) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
        throw new Error(`Unrecognized ${label}; leave the KMail untouched and reconcile.`);
    }
    return Number(value);
}

export function normalizeMail(raw, parse) {
    // Never parse gift contents as auction funds or commands. A donation receipt
    // lets us thank the sender once while leaving the package untouched in KoL.
    const donation = raw.type === 'giftshop';
    if (raw.type !== 'normal' && !donation) return null;
    if (String(raw.fromid) === '0' || Number(raw.fromid) === BOT_ID) return null;
    const parsed = donation ? null : parse(raw.message, raw.type);
    if (parsed?.valentine) return null;
    if (!donation && parsed.insideNote !== null) return null;
    const id = String(whole(raw.id, 'message ID'));
    const sender = whole(raw.fromid, 'sender ID');
    if (id === '0' || sender < 1 || sender === BOT_ID) throw new Error('System/self mail requires manual inspection.');
    if (donation) return {
        id, sender_id: sender, sender_name: String(raw.fromname),
        received_at: new Date(whole(raw.azunixtime, 'KMail time') * 1000).toISOString(),
        command: { type: 'donation' }, meat: 0, items: [], raw,
    };
    const command = parseCommand(parsed.msg);
    // Unknown normal mail with assets is refunded, never silently donated.
    // Empty chatter without assets remains untouched to avoid reply loops.
    if (command.type === 'unknown' && Number(parsed.meat) === 0 && parsed.items.length === 0) return null;
    const grouped = new Map();
    for (const item of parsed.items) {
        const itemId = whole(item.id, 'item ID', 2147483647);
        const quantity = whole(item.quantity, 'quantity', 5000000000);
        if (!itemId || !quantity) throw new Error('Invalid attachment; inspect KMail.');
        grouped.set(itemId, (grouped.get(itemId) || 0) + quantity);
        whole(grouped.get(itemId), 'total quantity', 5000000000);
    }
    return {
        id, sender_id: sender, sender_name: String(raw.fromname),
        received_at: new Date(whole(raw.azunixtime, 'KMail time') * 1000).toISOString(),
        command, meat: whole(parsed.meat, 'Meat'),
        items: [...grouped].sort(([a], [b]) => a - b).map(([id, quantity]) => ({ id, quantity })), raw,
    };
}

export function assertSolvent(snapshot, liabilities, reserve = 0) {
    if (BigInt(snapshot.meat) < BigInt(liabilities.meat) + BigInt(reserve)) throw new Error(reserve > 0
        ? 'Meat balance is below escrow obligations plus the optional operating reserve. Reconcile before sending.'
        : 'Meat balance is below recorded escrow obligations. Reconcile before sending.');
    for (const [id, quantity] of Object.entries(liabilities.items)) {
        if (BigInt(snapshot.items[id] || 0) < BigInt(quantity)) throw new Error(`Item #${id} is below escrow obligations. Reconcile before sending.`);
    }
}
