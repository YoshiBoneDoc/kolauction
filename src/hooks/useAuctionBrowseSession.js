import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { AUCTION_BROWSE_VISIT, clampAuctionPriceParams, normalizeAuctionBrowseParams, persistAuctionBrowseParams,
    readAuctionBrowseSession, restoreAuctionBrowseParams, writeAuctionBrowseSession } from '../lib/auctionBrowseSession';

export default function useAuctionBrowseSession({ priceBounds, isLoading, error }) {
    const [params, routeSetParams] = useSearchParams();
    const location = useLocation();
    const navigationType = useNavigationType();
    const handled = useRef(null);
    const restoring = useRef(null);
    const setParams = useCallback((next, options = {}) => {
        routeSetParams(previous => new URLSearchParams(typeof next === 'function' ? next(previous) : next),
            { ...options, state: { ...location.state, [AUCTION_BROWSE_VISIT]: true } });
    }, [routeSetParams, location.state]);

    useEffect(() => {
        if (restoring.current != null) {
            if (normalizeAuctionBrowseParams(params).toString() !== restoring.current || !location.state?.[AUCTION_BROWSE_VISIT]) return;
            restoring.current = null;
        }
        const entering = handled.current == null || (handled.current !== location.key && navigationType !== 'REPLACE');
        handled.current = location.key;
        if (entering) {
            const restored = restoreAuctionBrowseParams(params, readAuctionBrowseSession(), Boolean(location.state?.[AUCTION_BROWSE_VISIT]));
            writeAuctionBrowseSession(restored);
            if (restored.toString() !== normalizeAuctionBrowseParams(params).toString() || !location.state?.[AUCTION_BROWSE_VISIT]) {
                restoring.current = restored.toString();
                setParams(restored, { replace: true });
                return;
            }
        }
        persistAuctionBrowseParams(params);
        if (!isLoading && !error && priceBounds) {
            const clamped = clampAuctionPriceParams(params, priceBounds);
            if (clamped.toString() !== params.toString()) setParams(clamped, { replace: true });
        }
    }, [params, location.key, location.state, navigationType, setParams, priceBounds, isLoading, error]);

    const rememberSearch = useCallback(value => {
        const draft = new URLSearchParams(params);
        if (value) draft.set('q', value); else draft.delete('q');
        draft.delete('page');
        writeAuctionBrowseSession(draft, params);
    }, [params]);

    const resetSession = useCallback(() => {
        writeAuctionBrowseSession(new URLSearchParams());
        setParams({}, { replace: true });
    }, [setParams]);

    return { params, setParams, rememberSearch, resetSession, navigationType, locationKey: location.key };
}
