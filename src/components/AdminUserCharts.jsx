import PropTypes from 'prop-types';

const intervals = ['Last 24 Hours', 'Last 7 Days', 'Last 30 Days'];
const exact = value => BigInt(value).toLocaleString('en-US');

function Chart({ title, series, unavailable }) {
    const maximum = Math.max(1, ...series.flatMap(item => item.values.map(Number)));
    const ceiling = Math.ceil(maximum / 4) * 4;
    return <section aria-label={title} className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <div className="mt-2 flex min-h-4 flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
            {series.map(item => <span key={item.label} className="inline-flex items-center gap-1"><span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: item.color }} />{item.label}</span>)}
        </div>
        <div className="relative mt-2">
            <svg viewBox="0 0 360 190" className="block w-full text-gray-600" role="img" aria-label={`${title}: ${unavailable || 'number of users by rolling interval'}`}>
                <text x="38" y="12" fontSize="10" fill="currentColor">{title === 'User Activity' ? 'Users / logins' : 'Users'}</text>
                {[0, 1, 2, 3, 4].map(tick => {
                    const y = 148 - tick * 30;
                    return <g key={tick}>
                        <line x1="38" x2="354" y1={y} y2={y} stroke="currentColor" strokeOpacity="0.15" />
                        {!unavailable && <text x="32" y={y + 3} textAnchor="end" fontSize="10" fill="currentColor">{exact(ceiling * tick / 4)}</text>}
                    </g>;
                })}
                {intervals.map((label, index) => <g key={label}>
                    <text x={92 + index * 104} y="170" textAnchor="middle" fontSize="10" fill="currentColor">{label}</text>
                    {!unavailable && series.map((item, position) => {
                        const value = item.values[index];
                        const height = Number(value) / ceiling * 120;
                        const description = `${label} · ${item.label}: ${exact(value)}`;
                        const x = 92 + index * 104 - series.length * 12 + position * 24;
                        return <g key={item.label}>
                            <rect x={x} y={148 - height}
                            width="20" height={Math.max(height, 1)} rx="2" fill={item.color} tabIndex="0" aria-label={description}>
                            <title>{description}</title>
                            </rect>
                            {BigInt(value) > 0n && <text x={x + 10} y={148 - height - 6} textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" aria-hidden="true">{exact(value)}</text>}
                        </g>;
                    })}
                </g>)}
            </svg>
            {unavailable && <p className="absolute inset-x-5 top-1/3 rounded bg-gray-50 px-2 py-2 text-center text-xs text-gray-600">{unavailable}</p>}
        </div>
        {!unavailable && <table className="sr-only"><caption>{title} exact counts</caption><thead><tr><th>Interval</th>{series.map(item => <th key={item.label}>{item.label}</th>)}</tr></thead>
            <tbody>{intervals.map((label, index) => <tr key={label}><th>{label}</th>{series.map(item => <td key={item.label}>{exact(item.values[index])}</td>)}</tr>)}</tbody></table>}
    </section>;
}

Chart.propTypes = {
    title: PropTypes.string.isRequired,
    series: PropTypes.arrayOf(PropTypes.shape({ label: PropTypes.string.isRequired, color: PropTypes.string.isRequired, values: PropTypes.arrayOf(PropTypes.string).isRequired })).isRequired,
    unavailable: PropTypes.string,
};

export default function AdminUserCharts({ registrationCounts, loginActivity }) {
    return <div className="mb-4">
        <div className="grid gap-3 md:grid-cols-2">
            <Chart title="User Activity" series={[
                { label: 'Unique Active Users', color: '#1e40af', values: loginActivity?.unique_users || [] },
                { label: 'Total Logins', color: '#93c5fd', values: loginActivity?.total_logins || [] },
            ]} unavailable={loginActivity?.status === 'recording' ? undefined : 'Unavailable: successful login events are not currently recorded for analytics.'} />
            <Chart title="New Users" series={[{ label: 'New accounts', color: '#1e40af', values: registrationCounts || [] }]}
                unavailable={registrationCounts ? undefined : 'Registration counts unavailable. Apply the user charts database migration.'} />
        </div>
        {loginActivity?.status === 'recording' && <p className="mt-2 text-xs text-gray-500">Password logins recorded since {new Date(loginActivity.recording_since).toLocaleString()}. Windows extending before that time show partial counts. Refreshes and visits are excluded.</p>}
        <p className="mt-2 text-xs text-gray-500">Rolling 24-hour, 7-day and 30-day windows ending at the update time below. New users are counted by account creation time. Login counts cannot be inferred from visits or token refreshes.</p>
    </div>;
}

AdminUserCharts.propTypes = { loginActivity: PropTypes.shape({ status: PropTypes.string, recording_since: PropTypes.string, unique_users: PropTypes.arrayOf(PropTypes.string), total_logins: PropTypes.arrayOf(PropTypes.string) }), registrationCounts: PropTypes.arrayOf(PropTypes.string) };
