export const WALL_PAGE_SIZE = 24;

export async function loadWallOfShame(client, page = 0) {
    if (!client) throw new Error('The gallery is not connected yet. Please try again later.');
    const { data, error } = await client.rpc('khub_wall_of_shame', {
        p_offset: page * WALL_PAGE_SIZE, p_limit: WALL_PAGE_SIZE,
    });
    if (error) throw new Error('The gallery could not be loaded. Please try again later.');
    if (!data || !Array.isArray(data.entries) || !Number.isSafeInteger(data.total) || data.total < 0) {
        throw new Error('The gallery could not be loaded. Please try again later.');
    }
    return data;
}
