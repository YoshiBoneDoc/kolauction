// Never retry a financial write because an optional display refresh failed.
export async function submitConfirmedBid(write, reconcile) {
    const refresh = () => { try { void Promise.resolve(reconcile()).catch(() => {}); } catch { /* A read cannot change the write result. */ } };
    try { await write(); }
    catch (error) { refresh(); throw error; }
    refresh();
}
