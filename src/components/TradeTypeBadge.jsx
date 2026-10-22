import PropTypes from 'prop-types';

export default function TradeTypeBadge({ escrow = false, compact = false, short = false }) {
    const size = compact ? 'px-1.5 text-[11px] leading-3' : 'px-2 text-xs';
    const colors = escrow ? 'border-violet-200 bg-violet-100 text-violet-600' : 'border-[#A5DADD] bg-[#E0F2F3] text-[#238B95]';
    return <span className={`inline-flex rounded border py-0.5 font-medium ${size} ${colors}`}>
        {escrow ? 'Escrow' : short ? 'Direct' : 'Direct trade'}
    </span>;
}

TradeTypeBadge.propTypes = {
    escrow: PropTypes.bool,
    compact: PropTypes.bool,
    short: PropTypes.bool,
};
