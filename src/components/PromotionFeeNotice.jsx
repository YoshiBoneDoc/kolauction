import PropTypes from 'prop-types';
import useEscrowFeePreview from '../hooks/useEscrowFeePreview';

export default function PromotionFeeNotice({ active = true }) {
    const { enabled, promotion } = useEscrowFeePreview(0, active);
    if (!enabled) return null;
    if (!promotion?.messages?.form) return null;
    return <p className="whitespace-pre-line text-xs leading-relaxed text-blue-700 dark:text-blue-300">{promotion.messages.form}</p>;
}

PromotionFeeNotice.propTypes = { active: PropTypes.bool };
