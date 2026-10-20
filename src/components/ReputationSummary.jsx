import PropTypes from 'prop-types';
import { reputationSummary, reputationScore } from '../lib/reputation';
import FeedbackCounts from './FeedbackCounts';

export default function ReputationSummary({ stats, detailed = false }) {
    const summary = reputationSummary(stats);
    if (!summary) return <p className="text-sm text-gray-600">Ratings unavailable.</p>;
    return <section className="space-y-3 border-t pt-4" aria-label="Reputation summary">
        <h2 className="font-bold">{detailed ? 'Reputation' : 'Overall reputation'}: {reputationScore(summary.overall)}</h2>
        {detailed ? <div className="max-w-full overflow-x-auto">
            <table className="w-full text-left text-sm">
                <caption className="sr-only">Direct-settlement feedback by role</caption>
                <thead><tr className="border-b text-gray-600">
                    <th scope="col" className="py-2 pr-3">Role</th><th scope="col" className="px-2 py-2 text-right">Positive</th><th scope="col" className="px-2 py-2 text-right">Negative</th><th scope="col" className="py-2 pl-2 text-right">Score</th>
                </tr></thead>
                <tbody>{[['seller', 'As Seller'], ['buyer', 'As Buyer'], ['overall', 'Overall']].map(([key, label]) => <tr key={key} className={`border-b last:border-0 ${key === 'overall' ? 'font-semibold' : ''}`}>
                    <th scope="row" className="whitespace-nowrap py-3 pr-3 font-medium">{label}</th>
                    <td className="px-2 py-3 text-right text-green-800">{summary[key].positive.toLocaleString('en-US')}</td>
                    <td className="px-2 py-3 text-right text-red-700">{summary[key].negative.toLocaleString('en-US')}</td>
                    <td className="py-3 pl-2 text-right">{reputationScore(summary[key])}</td>
                </tr>)}</tbody>
            </table>
        </div> : <FeedbackCounts positive={summary.overall.positive.toString()} negative={summary.overall.negative.toString()} />}
        {detailed && <p className="text-xs text-gray-600">Score = positive minus negative. Overall combines seller and buyer feedback. Escrow trades do not contribute. These are participant responses, not a completion rate; administrators can exclude negative counts after review.</p>}
    </section>;
}
ReputationSummary.propTypes = { stats: PropTypes.object.isRequired, detailed: PropTypes.bool };
