import PropTypes from 'prop-types';
import useEscrowFeePreview from '../hooks/useEscrowFeePreview';

export default function PromotionFeeNotice({ active = true }) {
    const { enabled } = useEscrowFeePreview(0, active);
    if (!enabled) return null;
    return <p className="text-xs leading-relaxed text-blue-700 dark:text-blue-300">For November: Your next trade is commission-free while your completed escrow volume is under 20m Meat, regardless of the trade&apos;s value. Afterward, commission is 2% on the first 1b Meat and 1% above.</p>;
}

PromotionFeeNotice.propTypes = { active: PropTypes.bool };
