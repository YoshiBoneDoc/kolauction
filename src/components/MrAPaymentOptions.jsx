import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { createMarketPriceService } from '../lib/marketPrices';
import { supabase } from '../lib/supabase';
import { MR_A_ITEM_ID, MR_A_RATE_STEP, mrAReferenceRange } from '../lib/mrAPayment';
import { parseMeatAmount } from '../lib/auctionInputs';

const prices = createMarketPriceService(supabase);
export default function MrAPaymentOptions({ enabled, rate, onChange }) {
    const [quote, setQuote] = useState(null);
    const [rateText, setRateText] = useState(null);
    const currentRate = useRef(rate);
    const rateInput = useRef(null);
    currentRate.current = rate;
    useEffect(() => {
        let active = true;
        if (enabled) prices.load([MR_A_ITEM_ID]).then(rows => {
            if (!active) return;
            const record = rows.get(MR_A_ITEM_ID);
            setQuote(record);
            const range = mrAReferenceRange(record);
            if (range && currentRate.current == null) onChange(true, range.reference);
        });
        return () => { active = false; };
    }, [enabled, onChange]);
    const range = mrAReferenceRange(quote);
    const minimum = range?.minimum, maximum = range?.maximum;
    useEffect(() => {
        rateInput.current?.setCustomValidity(rate != null && (!Number.isSafeInteger(rate) || minimum == null || maximum == null || rate < minimum || rate > maximum)
            ? 'Choose a whole Meat value within the permitted range.' : '');
    }, [rate, minimum, maximum]);
    function adjustRate(direction, percent = false) {
        setRateText(null);
        const value = BigInt(rate ?? range.reference);
        const step = percent ? (value + 50n) / 100n || 1n : BigInt(MR_A_RATE_STEP);
        const next = value + BigInt(direction) * step;
        onChange(true, Number(next < BigInt(minimum) ? BigInt(minimum) : next > BigInt(maximum) ? BigInt(maximum) : next));
    }
    const plainControl = '!min-h-0 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none';
    return <div className="mb-4 space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked, null)} />Accept Mr. A&apos;s as payment</label>
        {enabled && (range ? <>
            <div className="flex items-center gap-2">
                <span>Meat per Mr. A</span>
                <div className="relative w-44">
                <input ref={rateInput} aria-label="Meat per Mr. A" type="text" inputMode="text" value={rateText ?? (rate == null ? '' : rate.toLocaleString('en-US'))}
                    onChange={event => {
                        const text = event.target.value;
                        const value = text.trim() === '' ? null : parseMeatAmount(text);
                        setRateText(text);
                        onChange(true, value);
                    }}
                    onBlur={() => { if (rate != null || rateText?.trim() === '') setRateText(null); }}
                    onKeyDown={event => {
                        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                        event.preventDefault();
                        adjustRate(event.key === 'ArrowUp' ? 1 : -1, true);
                    }}
                    className="w-full rounded border border-gray-400 py-1 pl-2 !pr-14" required />
                <div className="absolute inset-y-0 right-2 flex items-center gap-1">
                    <div className="flex flex-col justify-center">{[1, -1].map(direction => <button key={direction} type="button"
                        aria-label={`${direction > 0 ? 'Increase' : 'Decrease'} Mr. A valuation by 1%`}
                        className={`${plainControl} !text-[8px] !leading-3 text-gray-600`}
                        onClick={() => adjustRate(direction, true)}>{direction > 0 ? '▲' : '▼'}</button>)}</div>
                    <span className="whitespace-nowrap text-[10px] text-gray-500">±1%</span>
                </div>
                </div>
                <div className="flex flex-col gap-0.5">{[1, -1].map(direction => <button key={direction} type="button" className={`${plainControl} !text-[10px] !leading-3 text-blue-700 underline`}
                    onClick={() => adjustRate(direction)}>{direction > 0 ? '+100k' : '−100k'}</button>)}</div>
                <div className="ml-1 border-l border-gray-400/40 pl-3">
                    <button type="button" title="Reset to the displayed market price" onClick={() => { setRateText(null); onChange(true, range.reference); }}
                        className={`${plainControl} inline-flex items-center gap-1 !text-xs text-gray-500`}>
                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10a9 9 0 1 1 1.5 7M3 4v6h6" /></svg>
                        <span className="underline">Reset</span>
                    </button>
                </div>
            </div>
            <p className="text-[10px] leading-tight text-gray-600">Allowed: {range.minimum.toLocaleString()}–{range.maximum.toLocaleString()} Meat (±5% of market). Each Mr. A is valued at your chosen rate when calculating the total bid (Mr. A&apos;s + Meat). This rate is locked once published.</p>
        </> : <p role="status">A fresh Mr. A quote is unavailable or loading. Disable this option to continue with Meat only.</p>)}
    </div>;
}
MrAPaymentOptions.propTypes = { enabled: PropTypes.bool.isRequired, rate: PropTypes.number, onChange: PropTypes.func.isRequired };
