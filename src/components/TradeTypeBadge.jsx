import PropTypes from 'prop-types';

export default function TradeTypeBadge({ escrow = false, compact = false, short = false, tiny = false }) {
    const size = tiny ? 'px-1 py-0 text-[10px] leading-3' : compact ? 'px-1.5 py-0.5 text-[11px] leading-3' : 'px-2 py-0.5 text-xs';
    const colors = escrow ? 'border-violet-200 bg-violet-100 text-violet-600' : 'border-[#A5DADD] bg-[#E0F2F3] text-[#238B95]';
    return <span className={`inline-flex rounded border font-medium ${size} ${colors}`}>
        {escrow ? 'Escrow' : short ? 'Direct' : 'Direct trade'}
    </span>;
}

TradeTypeBadge.propTypes = {
    escrow: PropTypes.bool,
    compact: PropTypes.bool,
    short: PropTypes.bool,
    tiny: PropTypes.bool,
};
