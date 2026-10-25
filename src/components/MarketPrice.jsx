import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { marketPrices, completedMarketPrices } from '../lib/marketPriceService';
import { marketPriceDisplay } from '../lib/marketPrices';

export default function MarketPrice({ itemId, auctionId, completed = false }) {
    const [result, setResult] = useState(null);
    const lookupId = completed ? auctionId : itemId;
    useEffect(() => {
        let mounted = true;
        (completed ? completedMarketPrices : marketPrices).load([lookupId]).then(rows => { if (mounted) setResult({ lookupId, completed, record: rows.get(lookupId) }); });
        return () => { mounted = false; };
    }, [lookupId, completed]);
    if (!result || result.lookupId !== lookupId || result.completed !== completed) return completed ? null : <p className="text-xs text-gray-500">Loading market price…</p>;
    const record = result.record;
    if (completed && !record?.has_snapshot) return null;
    const display = marketPriceDisplay(record);
    return <div className="space-y-0.5 text-xs text-gray-500">
        <p className={record?.available ? 'text-violet-600' : undefined}>{display.text}{completed && record?.available && <span> (at completion)</span>}{display.stale && <span> · Stale estimate</span>}</p>
    </div>;
}
MarketPrice.propTypes = { itemId: PropTypes.number, auctionId: PropTypes.string, completed: PropTypes.bool };
