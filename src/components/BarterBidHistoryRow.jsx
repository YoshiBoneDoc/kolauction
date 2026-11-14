import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import useAdministrator from '../hooks/useAdministrator';
import BarterOfferImages from './BarterOfferImages';
import { offerDescription } from '../lib/barter';

export default function BarterBidHistoryRow({ offer }) {
    const administrator = useAdministrator();
    const [expanded, setExpanded] = useState(false);
    const detailsId = useId();
    const timestamp = offer.historyAt || offer.acceptedAt;
    return <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-start gap-x-4 gap-y-2 py-3 text-sm">
        <div className="min-w-0">
            <span className="break-words font-medium text-gray-700">{offer.isOwn ? 'You' : administrator && offer.bidder ? offer.bidder : offer.bidderLabel || 'Bidder'}</span>
            <p className="mt-1 text-xs text-gray-500"><time dateTime={timestamp}>{new Date(timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></p>
        </div>
        <div className="ml-auto min-w-0 max-w-[65vw] text-right sm:max-w-sm">
            <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
            <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)} className="barter-history-toggle inline-flex items-center gap-1 bg-transparent text-[11px] text-gray-500">
                Offer details<svg aria-hidden="true" width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d={expanded ? 'M1 3h8L5 8Z' : 'M7 1v8L2 5Z'} /></svg>
            </button>
            <span className="font-medium text-gray-900">{offer.value.toLocaleString('en-US')} Meat</span>
            {offer.status === 'rejected' && <span className="text-xs text-red-600">Rejected</span>}
            </div>
            {expanded && <div id={detailsId} className="mt-2 min-w-0 text-right text-[11px] text-gray-500">
                <BarterOfferImages offer={offer} alignRight />
                <p className="mt-1 [overflow-wrap:anywhere]">{offerDescription(offer)}</p>
            </div>}
        </div>
    </li>;
}
BarterBidHistoryRow.propTypes = { offer: PropTypes.object.isRequired };
