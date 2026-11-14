import PropTypes from 'prop-types';
import { formatCompactMeat } from '../lib/formatMeat';

export default function BarterOfferImages({ offer, feedback = false, alignRight = false }) {
    return (
        <div className={alignRight ? 'flex flex-row-reverse flex-wrap items-center gap-1' : 'mt-2 flex flex-wrap items-start gap-1'} aria-label="Offered items and Meat">
            {offer.meat > 0 && <span title={`${offer.meat.toLocaleString('en-US')} Meat`} className="mr-1 inline-flex items-center gap-1 text-xs font-semibold"><img src="/art/meatstack.gif" alt="Meat" className="h-7 w-7 object-contain dark:invert" />{formatCompactMeat(offer.meat)}</span>}
            {offer.items.map(item => item.image && <span key={item.id} className="inline-flex flex-col items-center gap-1"><span className="inline-flex items-center gap-0.5"><img src={item.image} alt={item.name} title={`${item.quantity > 1 ? `${item.quantity.toLocaleString('en-US')} × ` : ''}${item.name}`} className="h-8 w-8 rounded bg-white object-contain p-0.5 [image-rendering:pixelated]" loading="lazy" />{item.quantity > 1 && <span className="text-[11px] text-gray-500">x{item.quantity.toLocaleString('en-US')}</span>}</span>{feedback && <span role="img" aria-label={`${item.name}: ${offer.rejectedItems?.includes(item.id) ? 'not accepted' : 'acceptable'}`} className={`text-xs ${offer.rejectedItems?.includes(item.id) ? 'text-red-600' : 'text-green-600'}`}>{offer.rejectedItems?.includes(item.id) ? '✕' : '✓'}</span>}</span>)}
        </div>
    );
}
BarterOfferImages.propTypes = { offer: PropTypes.object.isRequired, feedback: PropTypes.bool, alignRight: PropTypes.bool };
