import PropTypes from 'prop-types';
import RemainingTime from './RemainingTime';

export default function AuctionDetailFooter({ seller, active, endTime, now, countdown, note, children }) {
    return <div className="space-y-2 py-1 text-xs leading-5 text-gray-700">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 break-words">Sold by {seller}</p>
                {active && <span className="inline-flex shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">Live</span>}
            </div>
            {active && <div className="flex min-h-6 items-center border-l border-gray-300 pl-4 dark:border-gray-600">{countdown || <p className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${endTime - now <= 10800000 ? 'text-red-700' : 'text-gray-600'}`}>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>
                <time dateTime={new Date(endTime).toISOString()} title={new Date(endTime).toLocaleString()}><RemainingTime endTime={endTime} hideSeconds /> left</time>
            </p>}</div>}
            {note && <p className="ml-auto min-w-0 text-right text-[11px] text-gray-500">{note}</p>}
        </div>
        {children}
    </div>;
}

AuctionDetailFooter.propTypes = {
    seller: PropTypes.node.isRequired,
    active: PropTypes.bool.isRequired,
    endTime: PropTypes.number.isRequired,
    now: PropTypes.number.isRequired,
    countdown: PropTypes.node,
    note: PropTypes.node,
    children: PropTypes.node,
};
