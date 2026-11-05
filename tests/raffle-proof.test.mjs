import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyRaffleProof } from '../src/lib/raffleProof.js';
import { createFairRaffleDraw, sha256, FAIR_METHOD } from '../bot/src/raffle-beacon.mjs';
import { createRaffleDraw } from '../bot/src/raffle-draw.mjs';
const beacon = { round: 42, randomness: '8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3', signature: '95a9f9f5b231b7714de1553105d8ffdf3dcda24cfdb1e689319bccf79a9c8ce430a91b811fbfaf763900bc998b5d686a' };
function fixture() {
    const input = { raffleId: '00000000-0000-0000-0000-000000000001', purchases: [{ receiptId: 'private-a', playerId: '100', ticketCount: '2' }, { receiptId: 'private-b', playerId: '200', ticketCount: '3' }], prizes: [{ outcome: '1', itemId: '2', quantity: '3', probabilityBps: '2500' }, { outcome: '2', itemId: '364', quantity: '1', probabilityBps: '7500' }] };
    const manifest = [FAIR_METHOD, input.raffleId, '42', '5', '1234', 'f'.repeat(64), ...input.prizes.map(p => Object.values(p).join(','))].join('\n');
    input.fairness = { method: FAIR_METHOD, round: 42, manifest, commitmentHash: sha256(manifest) };
    const draw = createFairRaffleDraw(input, beacon, createRaffleDraw);
    const proof = { method: FAIR_METHOD, raffleId: input.raffleId, committedAt: '2023-08-23T15:08:00Z', round: 42, manifest, commitmentHash: sha256(manifest), beacon: { ...beacon }, result: { seed: draw.fairness.seed, winningTicket: draw.winningTicket, prizeIndex: draw.prizeIndex, selectedOutcome: draw.selectedOutcome }, displayedWinningTicket: String(BigInt(draw.winningTicket) + 1234n), prizes: input.prizes };
    return { input, proof, draw };
}
test('browser and standalone verifier reproduce both worker selections without private data', async () => {
    const { proof, draw } = fixture();
    const verified = await verifyRaffleProof(proof, proof.commitmentHash);
    assert.equal(verified.winningTicket, proof.displayedWinningTicket);
    assert.equal(verified.selectedOutcome, draw.selectedOutcome);
    assert.equal(verified.ticketHash, draw.ticketSamples[0]);
    assert.equal(verified.prizeHash, draw.prizeSamples[0]);
    assert.notEqual(verified.ticketHash, verified.prizeHash);
    assert.ok(readFileSync(new URL('../public/raffle-fairness-verifier.mjs', import.meta.url), 'utf8').startsWith(readFileSync(new URL('../src/lib/raffleProof.js', import.meta.url), 'utf8')));
});
test('altered commitments, randomness, signatures, scheduling, odds, ticket labels and results fail verification', async () => {
    const changes = [
        p => { p.manifest += '\n'; }, p => { p.commitmentHash = '0'.repeat(64); },
        p => { p.beacon.round++; }, p => { p.beacon.signature = '0'.repeat(96); },
        p => { p.beacon.randomness = '0'.repeat(64); }, p => { p.round++; },
        p => { p.committedAt = '2026-01-01T00:00:00Z'; },
        p => { p.prizes[0].probabilityBps = '9999'; },
        p => { p.result.winningTicket = '999999'; }, p => { p.result.prizeIndex = '0'; },
        p => { p.result.selectedOutcome = '99'; }, p => { p.displayedWinningTicket = '999999'; },
    ];
    for (const change of changes) {
        const { proof } = fixture(); change(proof);
        await assert.rejects(verifyRaffleProof(proof));
    }
    await assert.rejects(verifyRaffleProof(fixture().proof, '0'.repeat(64)), /previously saved/);
});
test('worker rejects input changes before calculating the draw', () => {
    for (const change of [i => { i.purchases[0].ticketCount++; }, i => { i.prizes[0].quantity++; }, i => { i.fairness.round++; }, i => { i.raffleId = 'another'; }]) {
        const { input } = fixture(); change(input);
        assert.throws(() => createFairRaffleDraw(input, beacon, createRaffleDraw), /commitment/);
    }
});
