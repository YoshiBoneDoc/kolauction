const milestones = [
    100_000n, 500_000n, 1_000_000n, 10_000_000n, 100_000_000n,
    500_000_000n, 1_000_000_000n, 2_000_000_000n, 4_000_000_000n,
    8_000_000_000n, 16_000_000_000n, 32_000_000_000n,
    64_000_000_000n, 128_000_000_000n,
];

export function meatStackPieceCount(total) {
    let amount;
    try { amount = BigInt(total ?? 0); }
    catch { amount = 0n; }

    let pieces = 0;
    for (const milestone of milestones) {
        if (amount < milestone) return pieces;
        pieces += 1;
    }

    return pieces;
}
