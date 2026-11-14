import { withReadDeadline } from './readDeadline.js';

export function parseLeaderboards(data) {
    if (!data || !Number.isFinite(Date.parse(data.refreshed_at))) throw new Error('Invalid leaderboard snapshot.');
    const result = { refreshedAt: data.refreshed_at };
    for (const category of ['volume', 'trades', 'donors']) {
        if (!Array.isArray(data[category]) || data[category].length > 10) throw new Error('Invalid leaderboard rows.');
        const ids = new Set();
        result[category] = data[category].map((row, index) => {
            if (typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim()
                || row.rank !== index + 1 || typeof row.value !== 'string' || !/^\d+$/.test(row.value) || BigInt(row.value) <= 0n) {
                throw new Error('Invalid leaderboard entry.');
            }
            ids.add(row.id);
            return { id: row.id, name: row.name, rank: row.rank, value: BigInt(row.value) };
        });
    }
    return result;
}
export async function readLeaderboards(client, signal) {
    if (!client) throw new Error('Leaderboards are unavailable.');
    return withReadDeadline(async abort => {
        let request = client.rpc('read_leaderboards');
        if (request.abortSignal) request = request.abortSignal(abort);
        const { data, error } = await request;
        if (error) throw new Error('Leaderboards could not be loaded. Please retry.');
        return parseLeaderboards(data);
    }, { signal });
}
export function compactLeaderboardValue(value) {
    for (const [unit, suffix, precision] of [[1_000_000_000n, 'B', 100n], [1_000_000n, 'M', 10n], [1000n, 'k', 10n]]) {
        if (value >= unit) {
            const rounded = (value * precision + unit / 2n) / unit;
            const fraction = String(rounded % precision).padStart(String(precision).length - 1, '0').replace(/0+$/, '');
            return `${rounded / precision}${fraction ? `.${fraction}` : ''}${suffix}`;
        }
    }
    return value.toLocaleString('en-US');
}
