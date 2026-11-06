export const reminderOptions = [[0, 'No reminder'], [5, '5 minutes before ending'], [15, '15 minutes before ending'],
    [30, '30 minutes before ending'], [60, '1 hour before ending'], [360, '6 hours before ending'],
    [720, '12 hours before ending'], [1440, '1 day before ending']];

export function createSavedAuctionService(client, getTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const valid = minutes => reminderOptions.some(([value]) => value === minutes);
    const timeZone = () => { try { return getTimeZone() || 'UTC'; } catch { return 'UTC'; } };
    async function readState(id = null, signal) {
        if (!client) throw new Error('Saved auctions unavailable.');
        const { data, error } = await client.rpc('read_saved_auctions', { p_id: id }).abortSignal(signal);
        const defaultMinutes = data?.default_reminder_minutes ?? 0;
        if (error || !Array.isArray(data?.rows) || data.rows.length > 200 || !valid(defaultMinutes)) throw new Error('Saved auctions unavailable.');
        return { rows: data.rows, defaultMinutes };
    }
    return {
        readState,
        async readIds(signal) {
            if (!client) throw new Error('Saved auctions unavailable.');
            const { data, error } = await client.rpc('read_saved_auction_ids').abortSignal(signal);
            if (error || !Array.isArray(data) || data.length > 200 || data.some(id => typeof id !== 'string')) throw new Error('Saved auctions unavailable.');
            return data;
        },
        async read(id = null, signal) { return (await readState(id, signal)).rows; },
        async set(id, saved, minutes = null) {
            if (!client || minutes !== null && !valid(minutes)) throw new Error('Invalid saved auction preference.');
            const { error } = await client.rpc('set_saved_auction', { p_id: id, p_saved: saved, p_minutes: minutes, p_time_zone: timeZone() });
            if (error) throw new Error('Saved auction could not be updated.');
        },
        async setDefault(minutes, applyAll = false) {
            if (!client || !valid(minutes)) throw new Error('Invalid reminder preference.');
            const { error } = await client.rpc('set_saved_reminder_default', { p_minutes: minutes, p_apply_all: applyAll, p_time_zone: timeZone() });
            if (error) throw new Error('Default reminder could not be updated.');
        },
    };
}
