import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import RaffleCardTime from './RaffleCardTime';
import { formatCompactMeat } from '../lib/formatMeat';
import { formatRaffleTickets } from '../lib/raffleTickets';
import './homeRaffle.css';

export default function RaffleAuctionCard({ raffle, userTicketCount = raffle.user_ticket_count ?? 0 }) {
    return <Link to={`/raffle/${raffle.id}`} className="home-raffle-card browse-raffle-card grid h-[134px] min-w-0 grid-cols-[60px_minmax(0,1fr)] grid-rows-[38px_minmax(0,1fr)_20px] gap-x-3 rounded-lg px-3 py-1.5 shadow-sm">
        <header className="col-span-2 flex min-w-0 items-start justify-between gap-3">
            <h2 title={raffle.name} className="line-clamp-2 min-w-0 flex-1 break-words text-base font-bold leading-5">{raffle.name}</h2>
            <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1.5 text-right">
                <time dateTime={raffle.ends_at} title={`Ends ${new Date(raffle.ends_at).toLocaleString()}`} className="text-[11px] leading-3 tabular-nums"><RaffleCardTime endTime={Date.parse(raffle.ends_at)} suffix=" left" /></time>
                <span className="home-raffle-label inline-flex shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-3">Raffle</span>
            </div>
        </header>
        <img src="https://wiki.kingdomofloathing.com/images/a/a1/Rafflebox.gif" alt="" loading="lazy" className="row-span-2 row-start-2 h-[60px] w-[60px] self-center object-contain [image-rendering:pixelated]" />
        <p className="col-start-2 row-start-2 min-w-0 self-center text-center text-[26px] font-bold leading-7" title={`${Number(raffle.ticket_price).toLocaleString('en-US')} Meat per ticket`}>{formatCompactMeat(Number(raffle.ticket_price))} Meat <span className="text-[11px] font-normal">/ ticket</span></p>
        <span className="col-start-2 row-start-3 inline-flex items-center justify-self-end gap-1 text-xs font-medium tabular-nums" title={`Your tickets: ${BigInt(userTicketCount).toLocaleString('en-US')}`} aria-label={`Your tickets: ${BigInt(userTicketCount).toLocaleString('en-US')}`}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Z" /><path d="M15 6v2m0 3v2m0 3v2" /></svg>{formatRaffleTickets(userTicketCount)}</span>
    </Link>;
}
RaffleAuctionCard.propTypes = { raffle: PropTypes.object.isRequired, userTicketCount: PropTypes.oneOfType([PropTypes.number, PropTypes.string]) };
