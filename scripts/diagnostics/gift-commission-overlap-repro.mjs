// Offline arithmetic diagnostic, not a production database replay.
// Source formulas: migration 098 bot_refresh_gift_protection and migration 096
// bot_gift_wrapping_liabilities. Requires active gift review and positive surplus.
import assert from 'node:assert/strict';
import { assertSolvent } from '../../bot/src/protocol.mjs';

const inventory = 145543894n; // Recorded D-1697 preparation snapshot.
const recordedLiabilities = 145562064n;
const reserve = 1000n;
const wrapping = 50n;
const settlingFees = 24003n + 12n + 5n + 500n; // Live giveaway auction fee records.

// In the positive-surplus branch, base liabilities and queued closet Meat cancel:
// protected surplus = inventory - base - closet - safe quota - reserve
// wrapping liabilities = base + protected surplus + closet + settling fees
// Therefore wrapping liabilities = inventory - safe quota - reserve + fees.
// Historical quota is inferred here, not independently sampled at failure time.
const inferredQuota = inventory + settlingFees - reserve - recordedLiabilities;
assert.equal(inferredQuota, 5350n);
assert.equal(inventory - inferredQuota - reserve + settlingFees, recordedLiabilities);
assert.throws(() => assertSolvent({ meat: inventory, items: {} },
    { meat: recordedLiabilities, items: {} }, reserve + wrapping));

// Illustrates the result if the same pending fees are excluded from surplus
// before being added as wrapping liabilities. This is not an implemented fix.
const withoutOverlap = recordedLiabilities - settlingFees;
assertSolvent({ meat: inventory, items: {} },
    { meat: withoutOverlap, items: {} }, reserve + wrapping);
console.log(JSON.stringify({
    model: 'conditional reproduction of local SQL formulas; not a database replay',
    settling_fees: String(settlingFees), inferred_historical_safe_quota: String(inferredQuota),
    recorded_liabilities: String(recordedLiabilities),
    inventory_shortfall_including_reserve_and_wrapping: String(recordedLiabilities + reserve + wrapping - inventory),
    original_check: 'rejects', hypothetical_without_commission_overlap: 'passes',
}, null, 2));
