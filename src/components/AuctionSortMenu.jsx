import { useEffect, useId, useRef } from 'react';
import PropTypes from 'prop-types';

function SignalBars({ descending }) {
    return <svg aria-hidden="true" width="22" height="18" viewBox="0 0 26 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        {[3, 6, 9, 12, 15, 18].map((height, index) => <path key={index} d={`M${2 + index * 4.3} 18v-${descending ? 21 - height : height}`} />)}
    </svg>;
}
SignalBars.propTypes = { descending: PropTypes.bool };

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
        return key.startsWith('price-') ? <><span>Price:</span><SignalBars descending={key === 'price-desc'} /></> : text;
    }
    return <div className="flex items-center gap-2 text-xs text-gray-500"><span>{title}</span>
        <details ref={menu} className="relative" onKeyDown={event => { if (event.key === 'Escape') { menu.current.open = false; menu.current.querySelector('summary').focus(); } }}>
            <summary aria-label={ariaLabel} className="auction-sort-trigger flex h-9 w-[170px] cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
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
