import { createHash } from 'node:crypto';

export const ITEM_SOURCE = 'https://raw.githubusercontent.com/kolmafia/kolmafia/main/src/main/resources/data/items.txt';
export const CATALOG_WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_PATH = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.gif$/;

export function validateCatalog(items, { minimum = 10000, minimumTradeable = 5000 } = {}) {
    if (!Array.isArray(items) || items.length < minimum || items.length > 50000) throw new Error('Incomplete item catalog; keeping the previous catalog.');
    const ids = new Set();
    let tradeable = 0;
    for (const item of items) {
        if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.id > 2147483647 || ids.has(item.id)
            || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128
            || typeof item.image !== 'string' || !IMAGE_PATH.test(item.image)
            || typeof item.tradeable !== 'boolean') throw new Error('Invalid or duplicate catalog item; keeping the previous catalog.');
        ids.add(item.id);
        if (item.tradeable) tradeable++;
    }
    if (tradeable < minimumTradeable) throw new Error('Missing tradeability data; keeping the previous catalog.');
    return items;
}

export function parseItemCatalog(text, limits) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES
        || !/^1\r?\n# item number\tname\tdescid\timage\tuse\taccess\tautosell\tplural/.test(text)) {
        throw new Error('Unexpected KoLmafia item format; keeping the previous catalog.');
    }
    const items = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
        if (!line || line.startsWith('#')) continue;
        const fields = line.split('\t');
        if (fields.length === 1 && /^\d+$/.test(fields[0])) continue; // Reserved/unknown IDs.
        if (fields.length < 7 || !/^[1-9]\d*$/.test(fields[0]) || !/^\d+$/.test(fields[2])) throw new Error('Malformed item row; keeping the previous catalog.');
        const access = fields[5] === '' ? [] : fields[5].split(',').map(flag => flag.trim());
        if (access.some(flag => !['q', 'g', 't', 'd'].includes(flag))) throw new Error('Unknown item access flag; keeping the previous catalog.');
        items.push({ id: Number(fields[0]), name: fields[1], image: fields[3], tradeable: access.includes('t') });
    }
    return validateCatalog(items, limits).sort((a, b) => a.id - b.id);
}

export async function fetchItemCatalog({ fetchImpl = fetch, signal, now = () => new Date() } = {}) {
    const timeout = AbortSignal.timeout(20000);
    const response = await fetchImpl(ITEM_SOURCE, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    if (!response.ok) throw new Error('KoLmafia item download failed; keeping the previous catalog.');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_BYTES) throw new Error('Item download exceeded its size limit.');
            chunks.push(Buffer.from(value));
        }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    const items = parseItemCatalog(bytes.toString('utf8'));
    return { source: ITEM_SOURCE, fetched_at: now().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), items };
}
