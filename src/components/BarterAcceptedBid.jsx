import PropTypes from 'prop-types';
import BarterOfferImages from './BarterOfferImages';

export default function BarterAcceptedBid({ offer, value = 0 }) {
    return (
                    <div className="space-y-2 py-4">
                        {value > 0 && <p className="w-fit border-b border-gray-200 pb-2 text-sm font-bold text-gray-800">Current Accepted Bid:</p>}
                        {offer && <>
                            <div><BarterOfferImages offer={offer} /></div>
                            <ul className="space-y-1 text-sm text-gray-600">
                                {offer.meat > 0 && <li>{offer.meat.toLocaleString('en-US')} Meat</li>}
                                {offer.items.map(item => <li key={item.id} className="ml-4 list-disc break-words">{item.quantity > 1 && `${item.quantity.toLocaleString('en-US')} × `}{item.name}</li>)}
                            </ul>
                        </>}
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-12">
                            <span className="text-3xl font-extrabold">{value ? `${value.toLocaleString('en-US')} Meat` : 'No bids'}</span>
                            {value > 0 && <span className="whitespace-nowrap text-xs font-normal text-gray-500">· Est. value</span>}
                        </p>
                    </div>
    );
}
BarterAcceptedBid.propTypes = { offer: PropTypes.object, value: PropTypes.number };
