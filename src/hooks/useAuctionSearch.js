import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

// Keep keystrokes local while URL-backed server results catch up.
export default function useAuctionSearch() {
    const { pathname } = useLocation();
    const [params, setParams] = useSearchParams();
    const query = params.get('q') || '';
    const [value, setValue] = useState(query);
    const pendingQuery = useRef(null);
    const previousPath = useRef(pathname);

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
        if (value === query) return;
        const timer = setTimeout(() => {
            pendingQuery.current = value;
            setParams(previous => {
                const next = new URLSearchParams(previous);
                next.delete('page');
                if (value) next.set('q', value); else next.delete('q');
                return next;
            }, { replace: true });
        }, 250);
        return () => clearTimeout(timer);
    }, [value, query, setParams]);

    return [value, setValue];
}
