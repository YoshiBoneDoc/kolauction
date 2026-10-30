import { useCallback, useState } from 'react';
import { normalizeAuctionAmount } from '../lib/auctionInputs';
import { listingPrice } from '../lib/listingPrice';

export default function useListingPrice(quantity, canonicalSide) {
    const [entry, setEntry] = useState({ value: '', side: null });
    const side = entry.side || canonicalSide;
    const fields = listingPrice(entry.value, side, quantity, canonicalSide);
    const setCanonical = useCallback(value => setEntry(current => ({ value: typeof value === 'function' ? value(current.value) : value, side: null })), []);
    return {
        ...fields,
        setCanonical,
        edit: (side, value) => setEntry({ side, value }),
        blur: () => setEntry(current => ({ ...current, value: normalizeAuctionAmount(current.value, { meat: true }) })),
    };
}
