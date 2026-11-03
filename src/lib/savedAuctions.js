export const reminderOptions = [[0, 'No reminder'], [5, '5 minutes before ending'], [15, '15 minutes before ending'],
    [30, '30 minutes before ending'], [60, '1 hour before ending'], [360, '6 hours before ending'],
    [720, '12 hours before ending'], [1440, '1 day before ending']];

export function createSavedAuctionService(client, getTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
    return {
        async read(id = null, signal) {
            if (!client) throw new Error('Saved auctions unavailable.');
            const { data, error } = await client.rpc('read_saved_auctions', { p_id: id }).abortSignal(signal);
            if (error || !Array.isArray(data?.rows) || data.rows.length > 200) throw new Error('Saved auctions unavailable.');
            return data.rows;
        },
        async set(id, saved, minutes = 0) {
            if (!client || !reminderOptions.some(([value]) => value === minutes)) throw new Error('Invalid saved auction preference.');
            let timeZone = 'UTC';
            try { timeZone = getTimeZone() || 'UTC'; } catch { /* Use explicit UTC when browser detection is unavailable. */ }
            const { error } = await client.rpc('set_saved_auction', { p_id: id, p_saved: saved, p_minutes: minutes, p_time_zone: timeZone });
            if (error) throw new Error('Saved auction could not be updated.');
        },
    };
}
