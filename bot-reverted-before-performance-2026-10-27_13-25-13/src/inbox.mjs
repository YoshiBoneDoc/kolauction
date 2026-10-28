import { parseDocument, DomUtils } from 'htmlparser2';
import { selectAll } from 'css-select';

export function compareMail(a, b) {
    const time = a.received_at.localeCompare(b.received_at);
    if (time) return time;
    const left = BigInt(a.id), right = BigInt(b.id);
    return left < right ? -1 : left > right ? 1 : 0;
}

// Only the game's mailbox heading and checkbox IDs are read. Message bodies,
// quoted links and timestamps displayed to players cannot control pagination.
export function parseInboxPage(html) {
    if (typeof html !== 'string' || html.length > 5000000) throw new Error('Unrecognized Inbox page.');
    const doc = parseDocument(html);
    const headers = selectAll('b', doc).map(node => DomUtils.textContent(node).replace(/\s+/g, ' ').trim());
    const header = headers.find(text => /^Messages:\s*Inbox\b/i.test(text));
    if (!header) throw new Error('Unrecognized Inbox heading.');
    const paged = header.match(/^Messages:\s*Inbox,\s*page\s+(\d+)\s*\(\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s*\)$/i);
    const single = header.match(/^Messages:\s*Inbox,\s*page\s+1\s*\(\s*(\d+)\s+messages?\s*\)$/i);
    if (!paged && !single) throw new Error('Unrecognized Inbox pagination.');
    const ids = selectAll('input[name]', doc).filter(node => node.attribs.type?.toLowerCase() === 'checkbox'
        && /^sel[1-9][0-9]{0,15}$/.test(node.attribs.name))
        .filter(node => { for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === 'blockquote') return false; return true; })
        .map(node => node.attribs.name.slice(3));
    const total = Number(paged ? paged[4] : single[1]);
    const expected = paged ? Number(paged[3]) - Number(paged[2]) + 1 : total;
    if (new Set(ids).size !== ids.length || ids.length !== expected || total > 10000) throw new Error('Incomplete Inbox page.');
    return { ids, total, next: paged && Number(paged[3]) < total ? Number(paged[1]) + 1 : null };
}

export async function readCompleteInbox(client) {
    const query = { what: 'kmail', count: 100, for: 'kHub escrow bot' };
    const raw = await client.fetchJson('api.php', { query, timeout: 20000 });
    if (!Array.isArray(raw)) throw new Error('Unexpected KoL inbox response. No messages processed.');
    if (raw.length < 100) return raw;
    // A full API page cannot prove there are no older bids. Enumerate every
    // inbox page, then fetch missing messages by their actual KoL IDs.
    const ids = new Set(); let page = 1; let total;
    for (let count = 0; count < 1000; count++) {
        const options = { method: 'GET', query: { box: 'Inbox', begin: String(page) }, responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000 };
        const response = client.session?.raw ? await client.session.raw('messages.php', options)
            : { status: 200, _data: await client.session('messages.php', options) };
        if (response.status !== 200) throw new Error('Inbox scan unavailable.');
        const parsed = parseInboxPage(response._data);
        if (total !== undefined && total !== parsed.total) throw new Error('Inbox changed during scan; retry before processing.');
        total = parsed.total;
        for (const id of parsed.ids) ids.add(id);
        if (parsed.next === null) break;
        if (parsed.next <= page) throw new Error('Inbox pagination did not advance.');
        page = parsed.next;
    }
    if (ids.size !== total || total < raw.length) throw new Error('Inbox scan incomplete.');
    const byId = new Map(raw.map(mail => [String(mail.id), mail]));
    for (const id of ids) {
        if (byId.has(id)) continue;
        const result = await client.fetchJson('api.php', { query: { what: 'kmail', id, for: 'kHub escrow bot' }, timeout: 20000 });
        const mail = Array.isArray(result) && result.length === 1 ? result[0] : result;
        if (!mail || String(mail.id) !== id) throw new Error('Missing Inbox message; retry before processing.');
        byId.set(id, mail);
    }
    // Include any API-visible mail arriving while the HTML pages were fetched.
    return [...byId.values()];
}
