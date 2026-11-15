import { useEffect, useId, useRef } from 'react';
import PropTypes from 'prop-types';

function SignalBars({ descending }) {
    return <svg aria-hidden="true" width="22" height="18" viewBox="0 0 26 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        {[3, 6, 9, 12, 15, 18].map((height, index) => <path key={index} d={`M${2 + index * 4.3} 18v-${descending ? 21 - height : height}`} />)}
    </svg>;
}
SignalBars.propTypes = { descending: PropTypes.bool };

function SortSymbol({ sort }) {
    if (!['ending', 'recommended', 'activity', 'newest'].includes(sort)) return null;
    return <svg aria-hidden="true" className="shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {sort === 'ending' && <><path d="M6 3h12M6 21h12M7 3v4c0 2 3 4 5 5-2 1-5 3-5 5v4M17 3v4c0 2-3 4-5 5 2 1 5 3 5 5v4" /><path d="m9 18 3-3 3 3H9Z" fill="currentColor" stroke="none" /></>}
        {sort === 'recommended' && <><circle cx="12" cy="12" r="9" /><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z" /></>}
        {sort === 'activity' && <><path d="M3 10a9 9 0 1 1 9 11M3 4v6h6" /><path d="M12 7v5l3 3" /></>}
        {sort === 'newest' && <><path d="m9 5 2.3 6.7L18 14l-6.7 2.3L9 23l-2.3-6.7L0 14l6.7-2.3L9 5Z" transform="translate(2 -1) scale(.85)" /><path d="m19 2 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" /></>}
    </svg>;
}
SortSymbol.propTypes = { sort: PropTypes.string.isRequired };

export default function AuctionSortMenu({ value, options, onChange, title = 'Sort', ariaLabel = 'Sort auctions' }) {
    const menu = useRef(null);
    const groupId = useId();
    useEffect(() => {
        function dismiss(event) {
            if (menu.current && !menu.current.contains(event.target)) menu.current.open = false;
        }
        document.addEventListener('pointerdown', dismiss);
        document.addEventListener('focusin', dismiss);
        return () => {
            document.removeEventListener('pointerdown', dismiss);
            document.removeEventListener('focusin', dismiss);
        };
    }, []);
    function label(key, text) {
        return key.startsWith('price-') ? <><span>Price:</span><SignalBars descending={key === 'price-desc'} /></> : <><SortSymbol sort={key} /><span>{text}</span></>;
    }
    return <div className="auction-sort-menu flex items-center gap-2 text-xs text-gray-500"><span>{title}</span>
        <details ref={menu} className="auction-sort-details relative" onKeyDown={event => { if (event.key === 'Escape') { menu.current.open = false; menu.current.querySelector('summary').focus(); } }}>
            <summary aria-label={ariaLabel} className="auction-sort-trigger flex h-9 w-[190px] cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
                {label(value, options.find(([key]) => key === value)?.[1])}<svg aria-hidden="true" className="ml-auto shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 9 6 6 6-6" /></svg>
            </summary>
            <fieldset className="absolute right-0 top-full z-30 mt-1 min-w-48 rounded-xl border border-gray-200 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800">
                <legend className="sr-only">{ariaLabel}</legend>
                {options.map(([key, text]) => <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 focus-within:ring-2 focus-within:ring-blue-400 dark:text-slate-200 dark:hover:bg-slate-700">
                    <input type="radio" name={groupId} checked={value === key} onChange={() => { onChange(key); menu.current.open = false; menu.current.querySelector('summary').focus(); }} className="sr-only" />
                    <span aria-hidden="true" className="w-3">{value === key ? '✓' : ''}</span>{label(key, text)}
                </label>)}
            </fieldset>
        </details>
    </div>;
}
AuctionSortMenu.propTypes = { value: PropTypes.string.isRequired, options: PropTypes.array.isRequired, onChange: PropTypes.func.isRequired, title: PropTypes.string, ariaLabel: PropTypes.string };
