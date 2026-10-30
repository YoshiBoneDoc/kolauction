import PropTypes from 'prop-types';

export default function PollResults({ results, compact = false }) {
    const percentage = count => results.total ? Math.round(count * 100 / results.total) : 0;
    if (Array.isArray(results.choices)) return <div className={`space-y-1 ${compact ? 'text-xs' : 'text-sm'}`}>
        {results.choices.map(choice => <div key={choice.index} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">{choice.label}</span><span className="shrink-0"><strong>{choice.count.toLocaleString('en-US')}</strong> ({percentage(choice.count)}%)</span>
        </div>)}
        <p className="text-slate-600">{results.total.toLocaleString('en-US')} {results.multiple ? 'voters · multiple answers allowed' : 'votes'}</p>
        {results.multiple && <p className="text-slate-500">Percentages show the share of voters choosing each answer and may total over 100%.</p>}
    </div>;
    return <div className={`flex flex-wrap gap-y-1 ${compact ? 'gap-x-4 text-xs' : 'gap-x-5 text-sm'}`}>
        <span>Yes: <strong>{results.yes.toLocaleString('en-US')}</strong> ({percentage(results.yes)}%)</span>
        <span>No: <strong>{results.no.toLocaleString('en-US')}</strong> ({percentage(results.no)}%)</span>
        <span className="text-slate-600">{results.total.toLocaleString('en-US')} votes</span>
    </div>;
}
PollResults.propTypes = { compact: PropTypes.bool, results: PropTypes.shape({ multiple: PropTypes.bool, yes: PropTypes.number, no: PropTypes.number, total: PropTypes.number.isRequired,
    choices: PropTypes.arrayOf(PropTypes.shape({index:PropTypes.number.isRequired,label:PropTypes.string.isRequired,count:PropTypes.number.isRequired})),
}).isRequired };
