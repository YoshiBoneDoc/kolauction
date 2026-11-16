export const PREVIOUS_RAFFLE_PAGE_SIZE = 10;

export async function loadPreviousRaffles(client, read, page, force = false) {
    const offset = (page - 1) * PREVIOUS_RAFFLE_PAGE_SIZE;
    // RLS retains audience restrictions. Fetch one extra row for pagination;
    // result reads are bounded, on demand, and authorization-scoped in memory.
    const { data } = await read(`previous-raffles:${page}`, () => client.from('mystery_raffles')
        .select('id,raffle_number,name,ends_at,state,completion_reason,winner_player_id,selected_outcome,prizes:mystery_raffle_prizes(outcome,name,quantity)')
        .eq('is_test', false).in('state', ['fulfilling', 'returning', 'settled', 'cancelled', 'empty'])
        .order('ends_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + PREVIOUS_RAFFLE_PAGE_SIZE), { force });
    const rows = await Promise.all(data.slice(0, PREVIOUS_RAFFLE_PAGE_SIZE).map(async row => {
        if (row.winner_player_id == null || row.selected_outcome == null) return row;
        const { data: winner } = await read(`result:${row.id}`, () => client.rpc('read_raffle_result', { p_id: row.id }), { force });
        return { ...row, winner };
    }));
    return { rows, hasNext: data.length > PREVIOUS_RAFFLE_PAGE_SIZE };
}
