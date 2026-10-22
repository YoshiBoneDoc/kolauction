import PropTypes from 'prop-types';
import { formatCompactMeat, formatPerItemMeat } from '../lib/formatMeat';

// Inline content keeps the total and its per-item equivalent centered as one unit.
export default function SellPrice({ amount, quantity, compact = true }) {
    return <>{compact ? formatCompactMeat(amount) : BigInt(amount).toLocaleString('en-US')} Meat{quantity > 1 && <span className="text-[0.65em] font-medium tracking-normal text-gray-700"> · {formatPerItemMeat(amount, quantity)} each</span>}</>;
}
SellPrice.propTypes = { amount: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired, quantity: PropTypes.number.isRequired, compact: PropTypes.bool };
