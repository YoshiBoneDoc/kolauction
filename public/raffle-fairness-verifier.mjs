// Independent verifier: no kHub API, session, private receipt data, or relay trust required.
import { fetchBeacon } from 'drand-client';
export const METHOD = 'khub-drand-quicknet-sha256-v1';
export const CHAIN = Object.freeze({
    hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    period: 3, genesis_time: 1692803367, schemeID: 'bls-unchained-g1-rfc9380',
});
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
async function sample(seed, domain, bound) {
    const space = 1n << 256n, limit = space - space % bound;
    for (let counter = 0; counter < 128; counter++) {
        const digest = await hash(`${METHOD}\n${seed}\n${domain}\n${counter}`), value = BigInt(`0x${digest}`);
        if (value < limit) return { index: value % bound, counter, hash: digest };
    }
    throw new Error('Rejection limit reached');
}
export async function verifyRaffleProof(proof, previouslySavedHash = '') {
    assert(proof?.method === METHOD && typeof proof.manifest === 'string' && proof.manifest.length < 10000, 'Unsupported or invalid proof');
    assert(await hash(proof.manifest) === proof.commitmentHash, 'Commitment hash mismatch');
    if (previouslySavedHash) assert(previouslySavedHash === proof.commitmentHash, 'Proof differs from your previously saved commitment');
    const lines = proof.manifest.split('\n');
    assert(lines[0] === METHOD && lines[1] === proof.raffleId && lines[2] === String(proof.round), 'Manifest identity mismatch');
    assert(/^[1-9][0-9]*$/.test(lines[3]) && /^(0|[1-9][0-9]*)$/.test(lines[4]) && /^[a-f0-9]{64}$/.test(lines[5]), 'Invalid ticket range or input hash');
    const total = BigInt(lines[3]), offset = BigInt(lines[4]);
    assert(total <= 9223372036854775807n, 'Ticket range exceeds ledger limit');
    const round = proof.round;
    assert(Number.isSafeInteger(round) && round > 0, 'Invalid beacon round');
    const beaconTime = (CHAIN.genesis_time + (round - 1) * CHAIN.period) * 1000;
    assert(Number.isFinite(Date.parse(proof.committedAt)) && Date.parse(proof.committedAt) + 120000 <= beaconTime, 'Commitment was not recorded before the scheduled beacon');
    const pool = lines.slice(6).map(line => {
        const values = line.split(',');
        assert(values.length === 4 && values.every(v => /^(0|[1-9][0-9]*)$/.test(v)), 'Invalid prize manifest');
        const [outcome, itemId, quantity, probabilityBps] = values;
        assert(BigInt(outcome) >= 1n && BigInt(outcome) <= 20n && BigInt(itemId) > 0n && BigInt(quantity) > 0n && BigInt(probabilityBps) <= 10000n, 'Invalid prize values');
        return { outcome, itemId, quantity, probabilityBps };
    });
    assert(pool.length > 0 && pool.length <= 20 && new Set(pool.map(p => p.outcome)).size === pool.length && pool.reduce((n, p) => n + BigInt(p.probabilityBps), 0n) === 10000n, 'Prize odds do not total 100%');
    assert(JSON.stringify(pool) === JSON.stringify(proof.prizes.map(p => Object.fromEntries(['outcome', 'itemId', 'quantity', 'probabilityBps'].map(k => [k, String(p[k])])))), 'Prize pool differs from commitment');
    assert(proof.beacon && /^[a-f0-9]{96}$/.test(proof.beacon.signature) && /^[a-f0-9]{64}$/.test(proof.beacon.randomness), 'Missing beacon');
    await fetchBeacon({ options: { disableBeaconVerification: false }, chain: () => ({ info: async () => CHAIN }), get: async () => proof.beacon }, round);
    const seed = await hash(`${METHOD}\n${proof.commitmentHash}\n${proof.beacon.randomness}`);
    const ticket = await sample(seed, 'ticket', total), prize = await sample(seed, 'prize', 10000n);
    let sum = 0n;
    const selected = pool.find(p => { sum += BigInt(p.probabilityBps); return prize.index < sum; });
    assert(proof.result?.seed === seed && proof.result.winningTicket === String(ticket.index + 1n) && proof.result.prizeIndex === String(prize.index) && proof.result.selectedOutcome === selected.outcome, 'Published result does not match verified randomness');
    const displayed = String(ticket.index + 1n + offset);
    assert(proof.displayedWinningTicket === displayed, 'Displayed ticket label mismatch');
    return { winningTicket: displayed, selectedOutcome: selected.outcome, ticketHash: ticket.hash, prizeHash: prize.hash, seed };
}

// Optional standalone Node usage: node raffle-fairness-verifier.mjs proof.json [saved-commitment-hash]
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('raffle-fairness-verifier.mjs')) {
    const { readFile } = await import('node:fs/promises');
    try {
        const proof = JSON.parse(await readFile(process.argv[2], 'utf8'));
        console.log('Verified:', await verifyRaffleProof(proof, process.argv[3] || ''));
    } catch (error) { console.error('Verification failed:', error.message); process.exitCode = 1; }
}
