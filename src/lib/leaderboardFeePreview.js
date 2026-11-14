// Display-only previews. These values never authorize or settle a financial trade.
export const leaderboardFeeBenefits = {
    leader: { label: 'Top leader rates', color: 'leader-rates', rates: [1, 1, 0.5, 0.5] },
    top3: { label: 'Top 3 leaderboard rates', color: 'top3-rates', rates: [1.5, 1.25, 0.75, 0.5] },
    donor: { label: 'Top donor rates', color: 'donor-rates', rates: [0, 0, 0, 0] },
};
export function getLeaderboardFeeBenefits(data, userId) {
    if (!data || !userId) return null;
    if (data.feeEligibility) {
        if (data.feeEligibility.donor) return leaderboardFeeBenefits.donor;
        if (data.feeEligibility.leader) return leaderboardFeeBenefits.leader;
        if (data.feeEligibility.top3) return leaderboardFeeBenefits.top3;
        return null;
    }
    if (data.donors?.some(row => row.id === userId && row.rank === 1)) return leaderboardFeeBenefits.donor;
    const ranks = ['volume', 'trades'].flatMap(category => data[category]?.filter(row => row.id === userId && row.rank >= 1 && row.rank <= 3).map(row => row.rank) || []);
    if (!ranks.length) return null;
    return Math.min(...ranks) === 1 ? leaderboardFeeBenefits.leader : leaderboardFeeBenefits.top3;
}
