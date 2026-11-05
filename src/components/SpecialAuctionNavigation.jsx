import { useContext } from 'react';
import { UserContext } from '../context/UserContext';
import { canViewRaffles } from '../lib/raffleVisibility';
import PropTypes from 'prop-types';
import TradeTypeBadge from './TradeTypeBadge';

export default function SpecialAuctionNavigation({ mode, onRaffle, onGiveaway, onStandard }) {
    const { currentUser } = useContext(UserContext);
    return <div className="special-auction-navigation mb-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
            {currentUser?.isAdmin && canViewRaffles(currentUser) && <button type="button" disabled={mode === 'raffle'} aria-pressed={mode === 'raffle'} className="raffle-mode-button raffle-mode-purple" onClick={onRaffle}>Raffle</button>}
            <button type="button" disabled={mode === 'giveaway'} aria-pressed={mode === 'giveaway'} className="raffle-mode-button raffle-mode-red" onClick={onGiveaway}>Giveaway</button>
        </div>
        <div className="flex items-center justify-between gap-3"><button type="button" onClick={onStandard} className="special-auction-back">← Standard Auction</button><TradeTypeBadge escrow /></div>
    </div>;
}
SpecialAuctionNavigation.propTypes = { mode: PropTypes.oneOf(['raffle', 'giveaway']).isRequired, onRaffle: PropTypes.func, onGiveaway: PropTypes.func.isRequired, onStandard: PropTypes.func.isRequired };
