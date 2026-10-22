import PropTypes from 'prop-types';

export default function PollResults({ results, compact = false }) {
    const percentage = count => results.total ? Math.round(count * 100 / results.total) : 0;
    return <div className={`flex flex-wrap gap-y-1 ${compact ? 'gap-x-4 text-xs' : 'gap-x-5 text-sm'}`}>
        <span>Yes: <strong>{results.yes.toLocaleString('en-US')}</strong> ({percentage(results.yes)}%)</span>
        <span>No: <strong>{results.no.toLocaleString('en-US')}</strong> ({percentage(results.no)}%)</span>
        <span className="text-slate-600">{results.total.toLocaleString('en-US')} votes</span>
    </div>;
}
PollResults.propTypes = { compact: PropTypes.bool, results: PropTypes.shape({ yes: PropTypes.number.isRequired, no: PropTypes.number.isRequired, total: PropTypes.number.isRequired }).isRequired };
