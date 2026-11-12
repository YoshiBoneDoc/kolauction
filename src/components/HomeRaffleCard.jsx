import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import RaffleCardTime from './RaffleCardTime';
import { formatCompactMeat } from '../lib/formatMeat';
import { formatRaffleTickets } from '../lib/raffleTickets';
import './homeRaffle.css';

export default function HomeRaffleCard({ raffle, userTicketCount = raffle.user_ticket_count ?? 0 }) {
    return <Link to={`/raffle/${raffle.id}`} draggable={false} className="home-raffle-card relative grid h-24 min-w-0 grid-cols-[40px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_16px] gap-x-2 gap-y-0.5 rounded-md p-2 shadow">
        <span className="home-raffle-tickets" title={`Your tickets: ${BigInt(userTicketCount).toLocaleString('en-US')}`} aria-label={`Your tickets: ${BigInt(userTicketCount).toLocaleString('en-US')}`}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Z" /><path d="M15 6v2m0 3v2m0 3v2" /></svg>{formatRaffleTickets(userTicketCount)}</span>
        <div className="col-start-1 row-span-2 row-start-1 flex items-center justify-center"><img src="https://wiki.kingdomofloathing.com/images/a/a1/Rafflebox.gif" alt="" draggable={false} loading="lazy" className="h-10 w-10 object-contain [image-rendering:pixelated]" /></div>
        <h3 title={raffle.name} className="col-start-2 row-start-1 line-clamp-2 self-center break-words text-sm font-bold leading-4 pr-12">{raffle.name}</h3>
        <p className="col-start-2 row-start-2 min-w-0 self-center text-center text-lg font-bold leading-[22px]" title={`${Number(raffle.ticket_price).toLocaleString('en-US')} Meat per ticket`}>{formatCompactMeat(Number(raffle.ticket_price))} Meat <span className="text-[10px] font-normal">/ ticket</span></p>
        <div className="col-span-2 col-start-1 row-start-3 flex min-w-0 items-center gap-1"><p className="min-w-0 flex-1 truncate text-[11px] leading-4"><time dateTime={raffle.ends_at}><RaffleCardTime endTime={Date.parse(raffle.ends_at)} prefix="Ends in " /></time></p><span className="home-raffle-label shrink-0 rounded border px-1 py-0 text-[10px] font-medium leading-3">Raffle</span></div>
    </Link>;
}
HomeRaffleCard.propTypes = { raffle: PropTypes.object.isRequired, userTicketCount: PropTypes.oneOfType([PropTypes.number, PropTypes.string]) };
