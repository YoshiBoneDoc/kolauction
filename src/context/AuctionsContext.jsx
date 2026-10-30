import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from 'react-router-dom';
import PropTypes from "prop-types";
import { supabase } from "../lib/supabase";
import { createAuctionService } from "../lib/auctions";
import { UserContext } from "./UserContext";
import { auctionReadRequest, auctionRefreshDelay, startAuctionRefresh } from '../lib/auctionRefresh';
import { auctionNow } from '../lib/auctionClock';
import { createAuctionReadCache } from '../lib/auctionReadCache';
import { createPublicAuctionReader } from '../lib/publicAuctionReader';

export const AuctionsContext = createContext();
const storage = createAuctionService(supabase, {
    publicReader: createPublicAuctionReader(supabase, { enabled: import.meta.env.VITE_SHARED_AUCTION_CACHE === 'true' }),
});

export const AuctionsProvider = ({ children }) => {
    const { currentUser, signedInUserId } = useContext(UserContext);
    const viewerId = signedInUserId === undefined ? currentUser?.id : signedInUserId;
    const { pathname, search } = useLocation();
    const request = useMemo(() => auctionReadRequest(pathname, search, currentUser?.id), [pathname, search, currentUser?.id]);
    const [authRevision, setAuthRevision] = useState(0);
    const scope = JSON.stringify([viewerId ?? null, currentUser?.isBanned ?? false, currentUser?.khubUsername ?? null, authRevision]);
    const cache = useMemo(() => createAuctionReadCache((key, signal, { fresh } = {}) => {
        if (key.startsWith('pending:')) return storage.pendingTrades(Number(key.slice(8)), { signal });
        return storage.load({ ...JSON.parse(key), signal, fresh });
    }, { scope }), [scope]);
    const cacheRef = useRef(cache);
    const authToken = useRef(null);
    cacheRef.current = cache;
    useEffect(() => {
        const { data } = supabase?.auth.onAuthStateChange((event, session) => {
            const token = session?.access_token ?? null;
            if (event === 'INITIAL_SESSION') { authToken.current = token; return; }
            // Supabase can announce the same signed-in session on tab focus.
            // A new token or user update can carry changed authorization.
            if (['SIGNED_IN', 'TOKEN_REFRESHED'].includes(event) && authToken.current === token) return;
            authToken.current = token;
            cacheRef.current.pause();
            setAuthRevision(value => value + 1);
        }) || {};
        return () => data?.subscription.unsubscribe();
    }, []);
    useEffect(() => {
        cache.resume();
        return () => cache.pause();
    }, [cache]);

    const shared = ['home', 'browse'].includes(request?.view);
    const key = request ? JSON.stringify(request) : null;
    const networkRequest = useMemo(() => key ? JSON.parse(key) : null, [key]);
    const subscribe = useCallback(listener => cache.subscribe(listener), [cache]);
    const getSnapshot = useCallback(() => cache.snapshot(key), [cache, key]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const auctions = snapshot.data?.auctions || [];
    const total = snapshot.data?.total ?? 0;
    const homeSections = snapshot.data?.homeSections;
    const siteTotals = snapshot.data?.siteTotals || null;
    // Bounds describe the whole public market, so keep them stable while a new
    // filter page loads (otherwise dragging the range disables its own slider).
    const bounds = useRef(null);
    if (snapshot.data?.priceBounds) bounds.current = { scope, value: snapshot.data.priceBounds };
    const priceBounds = request?.view === 'browse' && bounds.current?.scope === scope ? bounds.current.value : null;
    const seller = snapshot.data?.seller || null;
    const error = snapshot.error;
    const hasLoaded = snapshot.data != null;
    const isLoading = Boolean(key && !hasLoaded && !error);
    const isRefreshing = snapshot.refreshing;
    const publicDataDelayed = snapshot.data?.publicSnapshot?.delayed === true;

    const [pendingSelection, setPendingSelection] = useState({ scope, page: 1 });
    const pendingPage = pendingSelection.scope === scope ? pendingSelection.page : 1;
    const setPendingPage = page => setPendingSelection({ scope, page });
    const showPending = Boolean(currentUser?.id && shared);
    const pendingKey = showPending ? `pending:${pendingPage}` : null;
    const getPending = useCallback(() => cache.snapshot(pendingKey), [cache, pendingKey]);
    const pending = useSyncExternalStore(subscribe, getPending, getPending);
    const pendingTrades = pending.data?.auctions || [];
    const pendingTotal = pending.data?.total ?? 0;
    const pendingError = pending.error;
    const pendingHasLoaded = pending.data != null;
    const activeRead = useRef(null);
    activeRead.current = { cache, key, pendingKey };
    useEffect(() => { cache.retain([key, pendingKey]); }, [cache, key, pendingKey]);
    useEffect(() => {
        if (pending.data && !pending.error && pendingPage > Math.max(1, Math.ceil(pendingTotal / 12))) {
            setPendingSelection({ scope, page: Math.max(1, Math.ceil(pendingTotal / 12)) });
        }
    }, [scope, pending.data, pending.error, pendingPage, pendingTotal]);

    useEffect(() => {
        if (!key || networkRequest.view === 'profile' && !currentUser?.id) return;
        const delay = () => Math.max(auctionRefreshDelay(networkRequest, cache.snapshot(key).data?.auctions || [], auctionNow(), import.meta.env.VITE_SHARED_AUCTION_CACHE === 'true'), cache.retryAfter(key));
        const previous = cache.snapshot(key);
        const initialDelay = previous.error ? cache.retryAfter(key)
            : previous.updatedAt == null ? (networkRequest.view === 'browse' && (networkRequest.minPrice != null || networkRequest.maxPrice != null) ? 250 : 0)
                : Math.max(0, delay() - (Date.now() - previous.updatedAt));
        const stop = startAuctionRefresh({
            refresh: () => cache.load(key, { maxAge: shared ? 60000 : Math.min(5000, delay()) }),
            delay, document, initialDelay, jitter: shared ? 0.2 : 0,
        });
        return () => { stop(); cache.cancel(key); };
    }, [cache, key, networkRequest, currentUser?.id, shared]);

    useEffect(() => {
        if (!pendingKey) return;
        const previous = cache.snapshot(pendingKey);
        return startAuctionRefresh({
            refresh: () => cache.load(pendingKey, { maxAge: 5000 }),
            delay: 30000, document, jitter: 0.2,
            initialDelay: previous.updatedAt == null ? 0 : Math.max(0, 30000 - (Date.now() - previous.updatedAt)),
        });
    }, [cache, pendingKey]);

    // Only explicit refreshes and completed/failed write attempts invalidate the
    // cache. A post-write refresh queues after any older read, so it cannot be
    // satisfied by a response whose request preceded the write.
    const refreshReads = useCallback(async (fresh = false) => {
        // A write may finish after navigation. Refresh the currently selected
        // resource rather than refetching the page where the write began.
        const { cache, key, pendingKey } = activeRead.current;
        cache.invalidate();
        await cache.load(key, { force: true, fresh });
        if (pendingKey) await cache.load(pendingKey, { force: true });
    }, []);
    // Retry buttons still use the shared cache. Only action refreshes bypass it.
    const refreshAuctions = useCallback(() => refreshReads(), [refreshReads]);
    const refreshAfterAction = () => refreshReads(true);

    const addAuction = async (auction) => {
        const id = await storage.create(auction);
        // A failed follow-up read must not turn a successful write into an
        // apparent failure and cause the user to submit the listing twice.
        await refreshAfterAction();
        return id;
    };

    const placeBid = async (auctionId, amount) => {
        try {
            await storage.bid(auctionId, amount);
        } catch (failure) {
            await refreshAfterAction();
            throw failure;
        }
        await refreshAfterAction();
    };

    const confirmTrade = async (auctionId) => {
        try {
            await storage.confirmTrade(auctionId);
        } catch (failure) {
            await refreshAfterAction();
            throw failure;
        }
        await refreshAfterAction();
    };

    const rateTrade = async (auctionId, rating) => {
        await storage.rateTrade(auctionId, rating);
        await refreshAfterAction();
    };

    const purchaseAuction = async (auctionId) => {
        try {
            await storage.purchase(auctionId);
        } catch (failure) {
            await refreshAfterAction();
            throw failure;
        }
        await refreshAfterAction();
    };

    const reserveBuyQuantity = async (auctionId, quantity) => {
        try {
            const reservation = await storage.reserveBuy(auctionId, quantity);
            await refreshAfterAction();
            return reservation;
        } catch (failure) { await refreshAfterAction(); throw failure; }
    };

    const cancelBuyReservation = async (reservationId) => {
        try {
            const result = await storage.cancelBuyReservation(reservationId);
            await refreshAfterAction();
            return result;
        } catch (failure) { await refreshAfterAction(); throw failure; }
    };

    const cancelAuction = async (auctionId) => {
        try {
            await storage.cancel(auctionId);
        } catch (failure) {
            await refreshAfterAction();
            throw failure;
        }
        await refreshAfterAction();
    };

    return (
        <AuctionsContext.Provider value={{ auctions, total, homeSections, siteTotals, priceBounds, seller, isLoading, isRefreshing, hasLoaded, publicDataDelayed, error, pendingTrades, pendingTotal, pendingPage, setPendingPage, pendingError, pendingHasLoaded, addAuction, placeBid, purchaseAuction, confirmTrade, rateTrade, reserveBuyQuantity, cancelBuyReservation, cancelAuction, refreshAuctions }}>
            {children}
        </AuctionsContext.Provider>
    );
};

AuctionsProvider.propTypes = { children: PropTypes.node.isRequired };
