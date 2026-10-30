/* eslint-disable react/prop-types */

export default function ListingPriceInputs({ id, label, pricing, inputRef, required = false }) {
    return <fieldset className="mb-4 min-w-0">
        <legend className="mb-2 text-sm font-bold">{label}</legend>
        <div className="grid grid-cols-2 gap-3">
            {['whole', 'item'].map(side => <label key={side} htmlFor={`${id}-${side}`} className="min-w-0 text-sm font-medium">
                {side === 'whole' ? 'Whole Listing' : 'Per Item'}
                <input ref={side === 'whole' ? inputRef : undefined} id={`${id}-${side}`} type="text" inputMode="decimal" autoComplete="off"
                    required={required && !pricing.whole && !pricing.item} value={pricing[side]}
                    onChange={event => pricing.edit(side, event.target.value)} onBlur={pricing.blur}
                    aria-describedby={`${id}-help`} placeholder="e.g. 50k"
                    className="mt-1 block min-h-11 w-full min-w-0 rounded border border-gray-400 bg-white p-3 text-base text-gray-900" />
            </label>)}
        </div>
        <p id={`${id}-help`} className="mt-1 text-xs text-gray-600" aria-live="polite">{pricing.message || 'Meat • Enter either price; the other updates with quantity.'}</p>
    </fieldset>;
}
