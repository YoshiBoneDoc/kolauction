import PropTypes from 'prop-types';

export default function FeedbackCounts({ positive, negative }) {
    if (positive == null || negative == null) return <p className="text-sm text-gray-600">Ratings unavailable.</p>;
    const up = BigInt(positive), down = BigInt(negative);
    return <div className="space-y-1">
        <p className="flex flex-wrap gap-4 font-semibold">
            <span className="text-green-800" aria-label={`${up} thumbs up`}>👍 {up.toLocaleString('en-US')}</span>
            <span className="text-red-700" aria-label={`${down} thumbs down`}>👎 {down.toLocaleString('en-US')}</span>
        </p>
        {up === 0n && down === 0n && <p className="text-sm text-gray-600">No ratings yet.</p>}
    </div>;
}
FeedbackCounts.propTypes = { positive: PropTypes.oneOfType([PropTypes.number, PropTypes.string]), negative: PropTypes.oneOfType([PropTypes.number, PropTypes.string]) };
