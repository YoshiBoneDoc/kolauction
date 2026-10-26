import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { PRICE_SLIDER_STEPS, priceToSlider, sliderToPrice } from '../lib/auctionPriceRange';
import { formatCompactMeat } from '../lib/formatMeat';

export default function AuctionPriceRange({ bounds, minPrice = null, maxPrice = null, onChange }) {
    const low = bounds?.min ?? 0, high = bounds?.max ?? 0;
    const min = Math.max(low, Math.min(high, minPrice ?? low));
    const max = Math.max(min, Math.min(high, maxPrice ?? high));
    const [selected, setSelected] = useState({ min, max });
    useEffect(() => { setSelected({ min, max }); }, [min, max]);
    useEffect(() => {
        if (bounds && ((minPrice != null && minPrice !== min) || (maxPrice != null && maxPrice !== max))) {
            onChange({ min, max });
        }
    }, [bounds, minPrice, maxPrice, min, max, onChange]);
    const scale = { min: low, max: high };
    const lower = priceToSlider(selected.min, scale), upper = priceToSlider(selected.max, scale);
    const labelsClose = upper - lower < PRICE_SLIDER_STEPS * 0.12;
    function change(which, position) {
        const price = sliderToPrice(position, scale);
        const next = which === 'min' ? { min: Math.min(selected.max, price), max: selected.max }
            : { min: selected.min, max: Math.max(selected.min, price) };
        setSelected(next);
        onChange(next);
    }
    function labelPosition(position, text) {
        const halfWidth = `${text.length / 2 + 0.5}ch`;
        return { left: `clamp(${halfWidth}, ${position / 10}%, calc(100% - ${halfWidth}))` };
    }
    const minLabel = bounds ? formatCompactMeat(selected.min) : '—';
    const maxLabel = bounds ? formatCompactMeat(selected.max) : '—';

    return <fieldset className="auction-price-control min-w-0">
        <legend className="sr-only">Price range (Meat)</legend>
        <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" title="Prices in Meat. Filters bids or asking prices; available bounds include auction prices and market values."
                className="shrink-0 pt-2 text-xs font-semibold text-gray-800">Price</span>
            <div className="relative mx-2 h-9 min-w-0 flex-1">
                {labelsClose ? <span aria-hidden="true" style={labelPosition((lower + upper) / 2, `${minLabel} – ${maxLabel}`)}
                    className="absolute top-0 inline-flex -translate-x-1/2 gap-1 whitespace-nowrap text-[11px] font-medium leading-3 tabular-nums text-[color:var(--auction-range-label)]">
                    <span title={`${selected.min.toLocaleString('en-US')} Meat`}>{minLabel}</span>
                    <span>–</span>
                    <span title={`${selected.max.toLocaleString('en-US')} Meat`}>{maxLabel}</span>
                </span> : <>
                    <span aria-hidden="true" title={`${selected.min.toLocaleString('en-US')} Meat`} style={labelPosition(lower, minLabel)}
                        className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium leading-3 tabular-nums text-[color:var(--auction-range-label)]">{minLabel}</span>
                    <span aria-hidden="true" title={`${selected.max.toLocaleString('en-US')} Meat`} style={labelPosition(upper, maxLabel)}
                        className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium leading-3 tabular-nums text-[color:var(--auction-range-label)]">{maxLabel}</span>
                </>}
                <div className="absolute inset-x-0 top-5 h-1 rounded-full bg-[var(--auction-range-track)]" />
                <div className="absolute top-5 h-1 rounded-full bg-[var(--auction-range-active)]" style={{ left: `${lower / 10}%`, right: `${100 - upper / 10}%` }} />
                <input type="range" aria-label="Minimum price" min={0} max={PRICE_SLIDER_STEPS} step={1} value={lower}
                    aria-valuetext={`${selected.min.toLocaleString('en-US')} Meat`} disabled={!bounds || low === high}
                    onChange={event => change('min', Number(event.target.value))}
                    className={`auction-price-range absolute inset-x-0 top-1 h-9 w-full ${lower > PRICE_SLIDER_STEPS / 2 ? 'z-20' : 'z-10'}`} />
                <input type="range" aria-label="Maximum price" min={0} max={PRICE_SLIDER_STEPS} step={1} value={upper}
                    aria-valuetext={`${selected.max.toLocaleString('en-US')} Meat`} disabled={!bounds || low === high}
                    onChange={event => change('max', Number(event.target.value))}
                    className="auction-price-range absolute inset-x-0 top-1 z-10 h-9 w-full" />
            </div>
        </div>
    </fieldset>;
}
AuctionPriceRange.propTypes = {
    bounds: PropTypes.shape({ min: PropTypes.number.isRequired, max: PropTypes.number.isRequired }),
    minPrice: PropTypes.number, maxPrice: PropTypes.number, onChange: PropTypes.func.isRequired,
};
