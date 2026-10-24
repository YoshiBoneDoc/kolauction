import PropTypes from 'prop-types';
import StaticAuctionStrip from './StaticAuctionStrip';

export default function HighRollers({ auctions, now, children }) {
    return <StaticAuctionStrip auctions={auctions} now={now} title="High Rollers" label="High Rollers" className="mb-8">{children}</StaticAuctionStrip>;
}
HighRollers.propTypes = { auctions: PropTypes.arrayOf(PropTypes.object).isRequired, now: PropTypes.number.isRequired, children: PropTypes.node };
