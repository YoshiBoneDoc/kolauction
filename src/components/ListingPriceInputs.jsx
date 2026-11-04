/* eslint-disable react/prop-types */

export default function ListingPriceInputs({ id, label, pricing, inputRef, required = false, headingAction }) {
    return <fieldset className="mb-4 min-w-0">
        <legend className="mb-2 w-full text-sm font-bold"><span className="flex items-center justify-between gap-2"><span>{label}</span>{headingAction}</span></legend>
        <div className="grid grid-cols-2 gap-3">
            {['whole', 'item'].map(side => <label key={side} htmlFor={`${id}-${side}`} className="min-w-0 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                {side === 'whole' ? 'Whole Listing' : 'Per Item'}
                <input ref={side === 'whole' ? inputRef : undefined} id={`${id}-${side}`} type="text" inputMode="decimal" autoComplete="off"
                    required={required && !pricing.whole && !pricing.item} value={pricing[side]}
                    onChange={event => pricing.edit(side, event.target.value)} onBlur={pricing.blur}
                    aria-describedby={`${id}-help`} placeholder="e.g. 50k"
                    className="mt-0.5 block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
            </label>)}
        </div>
        <p id={`${id}-help`} className="mt-1 text-[11px] text-gray-600" aria-live="polite">{pricing.message || 'Enter either price, and the other automatically updates.'}</p>
    </fieldset>;
}
