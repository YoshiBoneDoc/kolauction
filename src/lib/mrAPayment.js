// Payment-policy primitives only. SQL must independently enforce these rules.
// This module does not enable mixed payments or authorize asset transfers.
export const MR_A_ITEM_ID = 194;
export const MR_A_PRICE_MAX_AGE_MS = 26 * 60 * 60 * 1000;
export const MR_A_RATE_STEP = 100_000;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function paymentLabel(meat, quantity = 0, value = null) {
    const parts = [];
    if (quantity) parts.push(`${quantity.toLocaleString('en-US')} Mr. A${quantity === 1 ? '' : "'s"}`);
    if (meat || !quantity) parts.push(`${meat.toLocaleString('en-US')} Meat`);
    return parts.join(' + ') + (quantity && value != null ? ` (${value.toLocaleString('en-US')} Meat value)` : '');
}

function integer(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
    return BigInt(value);
}

export function mrAReferenceRange(record, now = Date.now()) {
    if (record?.item_id !== MR_A_ITEM_ID || record.available !== true || record.readFailed
        || !Number.isSafeInteger(record.price_meat) || record.price_meat <= 0 || !Number.isFinite(now)) return null;
    const observed = Date.parse(record.observed_at), checked = Date.parse(record.checked_at);
    if (!Number.isFinite(observed) || !Number.isFinite(checked) || observed > checked
        || checked > now || now - observed >= MR_A_PRICE_MAX_AGE_MS
        || now - checked >= MR_A_PRICE_MAX_AGE_MS) return null;
    const price = BigInt(record.price_meat);
    return { reference: record.price_meat, minimum: Number((price * 95n + 99n) / 100n),
        maximum: Number(price * 105n / 100n > MAX ? MAX : price * 105n / 100n) };
}

export function mrAPaymentValue(meat, mrAQuantity, lockedRate) {
    const m = integer(meat, 'Meat amount'), q = integer(mrAQuantity, 'Mr. A quantity');
    const rate = lockedRate == null ? 0n : integer(lockedRate, 'Mr. A rate');
    if (q > 0n && rate === 0n) throw new Error('This auction does not accept Mr. A payments.');
    const total = m + q * rate;
    if (total > MAX) throw new Error('Payment value exceeds the exact integer transport limit.');
    return Number(total);
}

// Keep every Mr. A; only excess Meat can be removed to reach a Meat buyout.
// Reject an impossible composition atomically; never select a subset of items.
export function mrABuyoutPayment(meat, mrAQuantity, lockedRate, buyout) {
    const total = mrAPaymentValue(meat, mrAQuantity, lockedRate);
    const target = integer(buyout, 'buyout');
    if (target === 0n) throw new Error('Invalid buyout.');
    if (BigInt(total) < target) throw new Error('Payment does not meet the buyout.');
    const refundMeat = BigInt(total) - target;
    if (refundMeat > BigInt(meat)) throw new Error('Mr. A portion exceeds the buyout; choose fewer Mr. A\'s.');
    return { meat: meat - Number(refundMeat), mrAQuantity, value: buyout, refundMeat: Number(refundMeat) };
}

// calculatedFee includes the applicable tiered/promotional policy on full value.
export function mrACommission(meat, calculatedFee) {
    const m = integer(meat, 'Meat amount'), fee = integer(calculatedFee, 'commission');
    const collected = m < fee ? m : fee;
    return { collected: Number(collected), waived: Number(fee - collected), sellerMeat: Number(m - collected) };
}
