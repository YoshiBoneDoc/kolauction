import PropTypes from 'prop-types';

export default function TradeReportDismissals({ auction, compact = false }) {
    if (auction.escrowMode) return null;
    const roles = ['seller', 'buyer'].filter(role => auction[`${role}ReportExcluded`]);
    if (!roles.length) return null;
    if (compact) return <p className="text-xs leading-4 text-gray-500">{roles.length === 2
        ? 'Both incomplete reports were dismissed by an administrator.'
        : `The ${roles[0]}’s incomplete report was dismissed by an administrator.`}</p>;
    return <div className="space-y-1 pt-1 text-xs leading-5 text-slate-600">{roles.map(role => <p key={role}>
        <strong>An administrator dismissed the {role}’s incomplete report.</strong>{' '}
        No incomplete mark is counted against the {role === 'seller' ? 'buyer' : 'seller'} for this report.
    </p>)}</div>;
}

TradeReportDismissals.propTypes = { auction: PropTypes.object.isRequired, compact: PropTypes.bool };
