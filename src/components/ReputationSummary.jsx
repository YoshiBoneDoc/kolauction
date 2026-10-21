import TradeHistoryHelp from './TradeHistoryHelp';
import PropTypes from 'prop-types';
import { reputationSummary, reputationScore } from '../lib/reputation';
import FeedbackCounts from './FeedbackCounts';

export default function ReputationSummary({ stats, detailed = false }) {
    const summary = reputationSummary(stats);
    if (!summary) return <p className="text-sm text-gray-600">Ratings unavailable.</p>;
    const count = key => stats[key] == null ? '—' : BigInt(stats[key]).toLocaleString('en-US');
    return <div className="space-y-4">
        <section className="space-y-2 border-t pt-4" aria-label="Trade confirmations">
            <h2 className="font-bold">Trade confirmations</h2>
            <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm">
                <caption className="sr-only">Trade responses received from the other party, independent of feedback</caption>
                <thead><tr className="border-b text-xs text-gray-500"><th className="py-2 pr-3" scope="col">Role</th><th className="px-2 py-2 text-right" scope="col">Confirmed Complete</th><th className="py-2 pl-2 text-right" scope="col">Reported Incomplete</th></tr></thead>
                <tbody>{['seller', 'buyer'].map(role => <tr key={role} className="border-b last:border-0">
                    <th scope="row" className="whitespace-nowrap py-2 pr-3 font-medium">As {role === 'seller' ? 'Seller' : 'Buyer'}</th>
                    <td className="px-2 py-2 text-right text-green-800">{count(`${role}_confirmed`)}</td>
                    <td className="py-2 pl-2 text-right text-red-700">{count(`${role}_incomplete`)}</td>
                </tr>)}</tbody>
            </table></div>
        </section>
        <section className="space-y-2 border-t pt-4" aria-label="Reputation summary">
            <h2 className="font-bold">Feedback score: {reputationScore(summary.overall)}</h2>
            {detailed ? <div className="max-w-full overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <caption className="sr-only">Optional thumbs-up and thumbs-down feedback by role</caption>
                    <thead><tr className="border-b text-gray-600"><th scope="col" className="py-2 pr-3">Role</th><th scope="col" className="px-2 py-2 text-right">Thumbs up</th><th scope="col" className="px-2 py-2 text-right">Thumbs down</th><th scope="col" className="py-2 pl-2 text-right">Score</th></tr></thead>
                    <tbody>{[['seller', 'As Seller'], ['buyer', 'As Buyer'], ['overall', 'Overall']].map(([key, label]) => <tr key={key} className={`border-b last:border-0 ${key === 'overall' ? 'font-semibold' : ''}`}>
                        <th scope="row" className="whitespace-nowrap py-2 pr-3 font-medium">{label}</th>
                        <td className="px-2 py-2 text-right text-green-800">{summary[key].positive.toLocaleString('en-US')}</td>
                        <td className="px-2 py-2 text-right text-red-700">{summary[key].negative.toLocaleString('en-US')}</td>
                        <td className="py-2 pl-2 text-right">{reputationScore(summary[key])}</td>
                    </tr>)}</tbody>
                </table>
            </div> : <FeedbackCounts positive={summary.overall.positive.toString()} negative={summary.overall.negative.toString()} />}
            <details className="text-xs text-gray-600"><summary className="cursor-pointer">How this works</summary><TradeHistoryHelp /></details>
        </section>
    </div>;
}
ReputationSummary.propTypes = { stats: PropTypes.object.isRequired, detailed: PropTypes.bool };
