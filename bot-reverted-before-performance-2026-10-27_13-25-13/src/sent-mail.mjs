import { parseDocument, DomUtils } from 'htmlparser2';
import { selectAll, selectOne } from 'css-select';
import { createHash } from 'node:crypto';

const visibleText = html => DomUtils.textContent(parseDocument(String(html).replace(/<br\s*\/?\s*>|<\/(?:p|div)>/gi, '\n')));
const canonical = text => String(text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const numericId = value => /^[1-9][0-9]{0,18}$/.test(String(value || ''));

// Read only the Sent mailbox. Never infer failure from absence, and never accept
// a quoted reference in a different message as proof of a delivery.
export function parseSentPage(html) {
    if (typeof html !== 'string' || html.length > 5000000) throw new Error('Unrecognized Sent Mail page.');
    const doc = parseDocument(html);
    const text = canonical(DomUtils.textContent(doc));
    if (/There are no messages in this mailbox\./i.test(text)) return { messages: [], next: null };
    if (!/Messages:\s*Sent\b/i.test(text)) throw new Error('Not a recognized Sent Mail page.');
    const messages = [];
    for (const cell of selectAll('td[valign="top"]', doc)) {
        const inputs = selectAll('input[name]', cell).filter(node => /^sel[1-9][0-9]*$/.test(node.attribs.name));
        if (inputs.length !== 1) continue;
        const quote = selectOne('blockquote', cell);
        if (!quote) continue; // Unknown layout is manual review, never a guess.
        const header = DomUtils.getInnerHTML(cell).split(/<blockquote\b/i)[0];
        const headerDoc = parseDocument(header);
        if (!/\bTo\s*:/i.test(DomUtils.textContent(headerDoc))) continue;
        const recipients = [...new Set(selectAll('a[href]', headerDoc).map(node => {
            try {
                const url = new URL(node.attribs.href, 'https://www.kingdomofloathing.com/');
                return url.pathname === '/showplayer.php' ? url.searchParams.get('who') : null;
            } catch { return null; }
        }).filter(numericId))];
        if (recipients.length !== 1) continue;
        // Strip only recognized game attachment widgets from the visible body.
        // If the sent copy exposes assets, verify them too; unknown layouts fail
        // the exact body check and remain for manual review.
        const items = [];
        for (const node of selectAll('table.item[rel]', quote)) {
            const params = new URLSearchParams(node.attribs.rel);
            if (!numericId(params.get('id')) || !numericId(params.get('n') || '1')) continue;
            items.push({ id: params.get('id'), quantity: params.get('n') || '1' });
            DomUtils.removeElement(node);
        }
        let meat = null;
        for (const node of selectAll('center', quote)) {
            const match = canonical(DomUtils.textContent(node)).match(/^You (?:lose|send|sent|gain|acquire) ([0-9,]+) Meat[.!]?$/);
            if (!match || meat !== null) continue;
            meat = match[1].replaceAll(',', '');
            DomUtils.removeElement(node);
        }
        const body = canonical(visibleText(DomUtils.getInnerHTML(quote)));
        const id = inputs[0].attribs.name.slice(3);
        messages.push({ id, recipient_id: recipients[0], body, items, meat });
    }
    const pageMatch = text.match(/Messages:\s*Sent,\s*page\s+(\d+)\s*\(\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s*\)/i);
    const singleMatch = text.match(/Messages:\s*Sent,\s*page\s+1\s*\(\s*\d+\s+messages?\s*\)/i);
    if (!pageMatch && !singleMatch) throw new Error('Unrecognized Sent Mail pagination.');
    return { messages, next: pageMatch && Number(pageMatch[3]) < Number(pageMatch[4]) ? Number(pageMatch[1]) + 1 : null };
}

export function matchSentDelivery(delivery, messages) {
    const expected = canonical(visibleText(delivery.expected_message || ''));
    if (!expected) return { status: 'check_failed', candidate_ids: [] };
    const marker = delivery.reference_marker;
    if (!marker || !expected.includes(marker)) return { status: 'check_failed', candidate_ids: [] };
    const markerPattern = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])');
    const candidates = messages.filter(message => markerPattern.test(message.body));
    const exact = candidates.filter(message => {
        if (String(message.recipient_id) !== String(delivery.recipient_id) || message.body !== expected) return false;
        if (message.meat !== null && message.meat !== undefined && BigInt(message.meat) !== BigInt(delivery.meat || 0)) return false;
        if (message.items?.length && (message.items.length !== 1
            || String(message.items[0].id) !== String(delivery.item_id)
            || BigInt(message.items[0].quantity) !== BigInt(delivery.quantity || 0))) return false;
        return true;
    });
    const ids = [...new Set(candidates.map(message => message.id))];
    if (exact.length === 1 && ids.length === 1) {
        return { status: 'verified', message_id: exact[0].id, candidate_ids: ids,
            message_hash: createHash('sha256').update(expected).digest('hex') };
    }
    return { status: ids.length ? 'ambiguous' : 'not_found', candidate_ids: ids.slice(0, 20) };
}
