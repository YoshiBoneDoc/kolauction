// Leaderboard UI preview only. Never use these proposed rates to settle a sale.
export const loyaltyTiers = [
    { name: 'Base', minimum: 0, color: 'regular', rates: [5, 4, 3, 2] },
    { name: 'Silver', minimum: 50_000_000, color: 'silver', rates: [4, 3, 2.5, 1.5] },
    { name: 'Gold', minimum: 200_000_000, color: 'gold', rates: [3, 2.5, 2, 1.25] },
    { name: 'Platinum', minimum: 1_000_000_000, color: 'platinum', rates: [2.5, 2, 1.5, 1] },
    { name: 'Diamond', minimum: 3_000_000_000, color: 'diamond', rates: [2, 1.5, 1, 0.5] },
];
export const loyaltySaleBands = ['Below 10M', '10M–100M', '100M–1B', '1B+'];
export const previewTierForEscrowSales = sales => [...loyaltyTiers].reverse().find(tier => sales >= tier.minimum) || loyaltyTiers[0];
