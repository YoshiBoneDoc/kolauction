import { useContext } from 'react';
import { UserContext } from '../context/UserContext';
import { Link } from 'react-router-dom';
import useBarterRead from '../hooks/useBarterRead';
import { writeBarter } from '../lib/barter';
import ConfirmTradeButton from './ConfirmTradeButton';
import TradeFeedback from './TradeFeedback';

export default function BarterPendingTrades() {
    const { currentUser } = useContext(UserContext);
    const { data, error, refresh } = useBarterRead('read_barter_trades', {}, Boolean(currentUser && !currentUser.isBanned));
    if (error) return <p role="alert">Barter trade responses could not be loaded. <button onClick={refresh}>Retry</button></p>;
    if (!data?.length) return null;
    return <section aria-label="Your pending barter trades" className="mb-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <h2 className="font-bold">Barters awaiting your response</h2>
        {data.map(trade => <article key={trade.id} className="rounded border border-amber-200 bg-white p-3">
            <Link to={`/barter/${trade.id}`} className="font-semibold underline">{trade.quantity} × {trade.item}</Link>
            <p className="text-sm">{trade.completed ? 'Both players confirmed this trade.' : 'Exchange the agreed items and Meat, then confirm you received everything owed.'}</p>
            {trade.confirmed ? <TradeFeedback auctionId={trade.id} role={trade.isHost ? 'buyer' : 'seller'} rating={trade.rating} onRate={(id, rating) => writeBarter('rate_barter_partner', { p_id: id, p_rating: rating })} />
                : <ConfirmTradeButton auctionId={trade.id} onConfirm={id => writeBarter('confirm_barter_trade', { p_id: id })} className="button-green rounded px-3 py-2" />}
        </article>)}
    </section>;
}
