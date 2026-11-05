// Fail closed on shared transport errors; never fall back to per-viewer origin reads.
export async function readPublicRaffleCommitment(id) {
    const response = await fetch(`/api/public-raffle-commitment?id=${encodeURIComponent(id)}`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Commitment unavailable.');
    const data = await response.json();
    if (!Object.hasOwn(data, 'commitment')) throw new Error('Invalid commitment response.');
    return data.commitment;
}
