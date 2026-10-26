import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

// Seller pages still debounce server searches; cached browsing updates locally.
export default function useAuctionSearch(setParamsOverride = null, { immediate = false } = {}) {
    const { pathname } = useLocation();
    const [params, routeSetParams] = useSearchParams();
    const setParams = setParamsOverride || routeSetParams;
    const query = params.get('q') || '';
    const [value, setValue] = useState(query);
    const pendingQuery = useRef(null);
    const previousPath = useRef(pathname);
    const timer = useRef(null);

    useEffect(() => {
        if (previousPath.current === pathname && pendingQuery.current === query) {
            pendingQuery.current = null;
            return;
        }
        previousPath.current = pathname;
        pendingQuery.current = null;
        setValue(query);
    }, [pathname, query]);

    useEffect(() => {
        if (immediate || value === query) return;
        timer.current = setTimeout(() => {
            pendingQuery.current = value;
            setParams(previous => {
                const next = new URLSearchParams(previous);
                next.delete('page');
                if (value) next.set('q', value); else next.delete('q');
                return next;
            }, { replace: true });
        }, 250);
        return () => clearTimeout(timer.current);
    }, [value, query, setParams, immediate]);

    const changeValue = useCallback(next => {
        clearTimeout(timer.current);
        setValue(next);
        if (immediate) {
            pendingQuery.current = next;
            setParams(previous => {
                const params = new URLSearchParams(previous);
                params.delete('page');
                if (next) params.set('q', next); else params.delete('q');
                return params;
            }, { replace: true });
        }
    }, [immediate, setParams]);
    return [value, changeValue];
}
