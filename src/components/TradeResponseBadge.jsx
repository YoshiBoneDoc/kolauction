import PropTypes from 'prop-types';

export default function TradeResponseBadge({ status, role, username }) {
    return <span className="inline-flex flex-wrap items-center gap-2">
        <span className={`inline-flex rounded-[1px] border px-2 py-0.5 text-xs font-medium leading-4 ${status.background} ${status.color}`}>{status.label}</span>
        <span className="text-xs text-black">by {role}{username && ` (${username})`}</span>
    </span>;
}
TradeResponseBadge.propTypes = {
    status: PropTypes.shape({ label: PropTypes.string.isRequired, color: PropTypes.string.isRequired, background: PropTypes.string.isRequired }).isRequired,
    role: PropTypes.oneOf(['seller', 'buyer']).isRequired,
    username: PropTypes.string,
};
