// Informational display only. Never import these rates into settlement logic.
const brackets = ['Below 10M', '10M–100M', '100M–1B', '1B+'];
const privileges = [
    { rank: 1, rates: ['1', '1', '0.5', '0.5'] },
    { rank: 2, rates: ['1.5', '1.25', '0.75', '0.5'] },
];

export default function LeaderboardPrivileges() {
    return <section className="club-privileges" aria-labelledby="club-privileges-title">
        <h2 id="club-privileges-title">Leaderboard Perks</h2>
        <p className="club-privileges-description">The top 3 players on each leaderboard enjoy the following benefits while ranked.</p>
        <div className="club-privileges-grid">
            {privileges.map(privilege => <article key={privilege.rank} className={`club-privilege club-podium-place-${privilege.rank}`} aria-labelledby={`club-privilege-${privilege.rank}`}>
                <div className="club-privilege-heading">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {privilege.rank === 1 ? <><path d="m4 7 4.5 3L12 4l3.5 6L20 7l-2.5 10h-11L4 7Z" /><path d="M7 21h10" /></>
                            : <><path d="M7 3h10v5a5 5 0 0 1-10 0V3Z" /><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4l2 3H8l2-3Z" /></>}
                    </svg>
                    {privilege.rank === 2 && <svg className="club-privilege-silver-trophy" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M7 3h10v5a5 5 0 0 1-10 0V3Z" /><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-6-3h4l2 3H8l2-3Z" />
                    </svg>}
                    <h3 id={`club-privilege-${privilege.rank}`}>· #{privilege.rank}{privilege.rank === 2 && <> <span className="club-privilege-and">and</span> <span className="club-privilege-silver-rank">#3</span></>}</h3>
                </div>
                <dl className="club-privilege-rates">{brackets.map((bracket, index) => <div key={bracket}>
                    <dt>{bracket}</dt><dd>{privilege.rates[index]}%</dd>
                </div>)}</dl>
            </article>)}
        </div>
        <ul className="club-privileges-rules list-disc space-y-1 pl-4">
            <li>Escrow fee reductions as above</li>
            <li>Leaderboard ranks displayed on seller profiles</li>
            <li>All escrow fees waived for the top donor</li>
        </ul>
    </section>;
}
