import PropTypes from 'prop-types';
import { auctionFilters } from '../lib/auctionBrowsing';
import AuctionPriceRange from './AuctionPriceRange';

// Temporary switch: also disables URL/session price constraints in All Auctions.
export const AUCTION_PRICE_RANGE_ENABLED = true;

export function AuctionFiltersButton({ open, controls, count, onToggle }) {
    return (
        <button type="button" aria-expanded={open} aria-controls={controls} aria-label="Filters"
            onClick={onToggle}
            className={`auction-filters-button inline-flex h-9 w-[114px] shrink-0 items-center gap-2 rounded border px-3 text-sm font-medium ${count ? 'auction-filters-active border-[#DCA58D] bg-[#FCE8DC] text-[#A65332]' : 'border-[#E5D5CD] bg-white text-gray-800'}`}>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 5h16l-6 7v6l-4 2v-8z" /></svg>
            Filters
            <span aria-hidden={count === 0 ? true : undefined}
                aria-label={count > 0 ? `${count} active ${count === 1 ? 'filter' : 'filters'}` : undefined}
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] leading-none text-white ${count > 0 ? 'bg-[#A65332]' : 'invisible'}`}>
                {count > 0 ? count : ''}
            </span>
        </button>
    );
}
AuctionFiltersButton.propTypes = {
    open: PropTypes.bool.isRequired, controls: PropTypes.string.isRequired,
    count: PropTypes.number.isRequired, onToggle: PropTypes.func.isRequired,
};

export default function AuctionFilters({ id, status, trade, bounds, minPrice, maxPrice, ownership = null, onUpdate, onRangeChange, onClear }) {
    const ownershipLabel = ownership === 'others' ? 'Others' : ownership === '1' ? 'Mine' : 'All Auctions';
    const nextOwnership = ownership === 'all' ? 'others' : ownership === 'others' ? '1' : '';
    const nextOwnershipLabel = ownership === 'all' ? 'Others' : ownership === 'others' ? 'Mine' : 'All Auctions';
    return <section id={id} aria-label="Auction filters"
        className="auction-advanced-filters mt-2 flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-[#E8D8D0] pt-1.5">
        <fieldset className="shrink-0">
            <legend className="sr-only">Trading method</legend>
            <div role="group" aria-label="Trading methods" className="flex items-center gap-1">
                {['escrow', 'direct'].map(method => {
                    const selected = trade === 'all' || trade === method;
                    const colors = selected
                        ? method === 'escrow'
                            ? 'border-violet-200 bg-violet-50 text-violet-600 hover:bg-violet-100'
                            : 'border-[#A5DADD] bg-[#F0F9F9] text-[#1F7480] hover:bg-[#E0F2F3]'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50';
                    return <button key={method} type="button" aria-pressed={selected}
                        onClick={() => onUpdate('trade', trade === 'all' ? (method === 'escrow' ? 'direct' : 'escrow') : trade === method ? 'none' : trade === 'none' ? method : '')}
                        className={`h-8 rounded border px-2.5 py-1 text-xs font-medium transition-colors ${colors}`}>
                        {method === 'escrow' ? 'Escrow' : 'Direct'}
                    </button>;
                })}
            </div>
        </fieldset>
        <label className="block w-56 max-w-full shrink-0">
            <span className="sr-only">Auction status</span>
            <select value={status} onChange={event => onUpdate('status', event.target.value)} className="h-8 w-full rounded border border-[#E5D5CD] bg-white px-2 text-sm font-normal text-gray-900">
                {auctionFilters.map(([value, label]) => <option key={value} value={value}>Status: {label}</option>)}
            </select>
        </label>
        {ownership != null && <button type="button" aria-label={`Auction ownership: ${ownershipLabel}`} aria-pressed={ownership !== 'all'}
            title={`Showing ${ownershipLabel}. Click to show ${nextOwnershipLabel}.`}
            onClick={() => onUpdate('mine', nextOwnership)}
            className={`auction-ownership-filter inline-flex h-8 w-[136px] max-w-full shrink-0 items-center gap-2 whitespace-nowrap rounded border border-blue-700 px-3 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50 ${ownership === 'all' ? 'bg-white' : 'bg-blue-50'}`}>
            <span className="flex-1 text-center">{ownershipLabel}</span>
            <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-base leading-none opacity-70">↺</span>
        </button>}
        {AUCTION_PRICE_RANGE_ENABLED && <div className="w-[320px] max-w-full shrink-0">
            <AuctionPriceRange bounds={bounds} minPrice={minPrice} maxPrice={maxPrice} onChange={onRangeChange} />
        </div>}
        <button type="button" onClick={onClear} className="auction-clear-filters inline-flex h-8 shrink-0 items-center border-0 bg-transparent p-0 text-xs font-medium text-[#A65332] underline underline-offset-2">Clear filters</button>
    </section>;
}
AuctionFilters.propTypes = {
    id: PropTypes.string.isRequired, status: PropTypes.string.isRequired, trade: PropTypes.string.isRequired,
    bounds: PropTypes.shape({ min: PropTypes.number.isRequired, max: PropTypes.number.isRequired }),
    minPrice: PropTypes.number, maxPrice: PropTypes.number, ownership: PropTypes.oneOf(['all', '1', 'others']),
    onUpdate: PropTypes.func.isRequired, onRangeChange: PropTypes.func.isRequired, onClear: PropTypes.func.isRequired,
};
