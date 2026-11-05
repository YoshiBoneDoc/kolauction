export function raffleHistoryStatus(row, now) {
    if (row.completion_reason === 'cancelled' || row.state === 'cancelled') return 'Canceled · ticket refund';
    if (row.completion_reason === 'no_tickets' || row.state === 'empty') return 'Closed without tickets';
    if (row.won != null) return row.won ? row.state === 'settled' ? 'Won · concluded' : 'Won · prize delivery pending' : 'Not selected';
    return row.state === 'active' && Date.parse(row.ends_at) > now ? 'Active' : 'Finalizing draw';
}
