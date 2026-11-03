import { useContext } from 'react';
import { UserContext } from '../context/UserContext';
import PropTypes from 'prop-types';
import useEscrowFeePreview from '../hooks/useEscrowFeePreview';

export default function PromotionFeeNotice({ active = true }) {
    const { currentUser } = useContext(UserContext) ?? {};
    const { enabled, volume } = useEscrowFeePreview(0, active);
    if (!enabled) return null;
    return <p className="text-sm text-gray-700">Temporary escrow promotion: your first 20m Meat of completed promotional Buy and Sell volume shares one allowance. If below 20m before settlement, the entire transaction is free, even above 20m. Afterward: 2% on the first 1b per transaction, 1% above 1b, rounded down. Each Buy fulfillment is a separate transaction. Buy orders already partially fulfilled when the promotion began have free remaining fulfillments while it is enabled; these still count toward promotional volume. {currentUser ? <>Your completed promotional volume: {BigInt(volume).toLocaleString('en-US')} Meat.</> : <>Sign in to see your introductory eligibility.</>} Settlement determines eligibility. Buy deposits retain the original fee reserve for safe reversal; unused funds are refunded when the order closes. The original schedule below applies when the promotion is disabled.</p>;
}

PromotionFeeNotice.propTypes = { active: PropTypes.bool };
