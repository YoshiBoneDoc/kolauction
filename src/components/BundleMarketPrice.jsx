import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { marketPrices } from '../lib/marketPriceService';
import { bundleMarketPriceDisplay } from '../lib/marketPrices';

export default function BundleMarketPrice({ items, completed = false }) {
    const key = JSON.stringify(items.map(({ id, quantity }) => ({ id, quantity })));
    const [result, setResult] = useState(null);
    useEffect(() => {
        let mounted = true;
        const components = JSON.parse(key);
        marketPrices.load(components.map(item => item.id)).then(records => {
            if (mounted) setResult({ key, display: bundleMarketPriceDisplay(components, records) });
        });
        return () => { mounted = false; };
    }, [key]);
    if (result?.key !== key) return <p className="text-xs text-gray-500">Loading market price…</p>;
    const display = result.display;
    return <p className={`text-xs ${display.available ? 'text-violet-500' : 'text-gray-500'}`}>
        {display.text}{completed && display.available && ' (current estimate)'}{display.stale && ' · Stale estimate'}
    </p>;
}
BundleMarketPrice.propTypes = { items: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.number.isRequired, quantity: PropTypes.number.isRequired })).isRequired, completed: PropTypes.bool };
