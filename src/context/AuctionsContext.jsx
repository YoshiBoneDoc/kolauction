import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from 'react-router-dom';
import PropTypes from "prop-types";
import { supabase } from "../lib/supabase";
import { createAuctionService } from "../lib/auctions";
import { UserContext } from "./UserContext";
import { auctionReadRequest, auctionRefreshDelay, startAuctionRefresh } from '../lib/auctionRefresh';
import { auctionNow } from '../lib/auctionClock';
import { createAuctionReadCache } from '../lib/auctionReadCache';

export const AuctionsContext = createContext();
const storage = createAuctionService(supabase);

export const AuctionsProvider = ({ children }) => {
    const { currentUser, signedInUserId } = useContext(UserContext);
    const viewerId = signedInUserId === undefined ? currentUser?.id : signedInUserId;
    const { pathname, search } = useLocation();
    const request = useMemo(() => auctionReadRequest(pathname, search, currentUser?.id), [pathname, search, currentUser?.id]);
    const [authRevision, setAuthRevision] = useState(0);
    const scope = JSON.stringify([viewerId ?? null, currentUser?.isBanned ?? false, currentUser?.khubUsername ?? null, authRevision]);
    const cache = useMemo(() => createAuctionReadCache((key, signal) => {
        if (key === 'dataset') return storage.loadDataset({ signal });
        if (key.startsWith('pending:')) return storage.pendingTrades(Number(key.slice(8)));
        return storage.load(JSON.parse(key));
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
    const key = shared ? 'dataset' : request ? JSON.stringify(request) : null;
    // Filter/search/page URL changes deliberately do not change this resource.
    const networkRequest = useMemo(() => key === 'dataset' ? { view: 'browse' } : key ? JSON.parse(key) : null, [key]);
    const subscribe = useCallback(listener => cache.subscribe(listener), [cache]);
    const getSnapshot = useCallback(() => cache.snapshot(key), [cache, key]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const auctions = snapshot.data?.auctions || [];
    const total = snapshot.data?.total ?? 0;
    const priceBounds = shared ? snapshot.data?.priceBounds || null : null;
    const seller = snapshot.data?.seller || null;
    const error = snapshot.error;
    const hasLoaded = snapshot.data != null;
    const isLoading = Boolean(key && !hasLoaded && !error);
    const isRefreshing = snapshot.refreshing;

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
    useEffect(() => {
        if (pending.data && !pending.error && pendingPage > Math.max(1, Math.ceil(pendingTotal / 12))) {
            setPendingSelection({ scope, page: Math.max(1, Math.ceil(pendingTotal / 12)) });
        }
    }, [scope, pending.data, pending.error, pendingPage, pendingTotal]);

    useEffect(() => {
        if (!key || networkRequest.view === 'profile' && !currentUser?.id) return;
        const delay = () => auctionRefreshDelay(networkRequest, cache.snapshot(key).data?.auctions || [], auctionNow());
        const previous = cache.snapshot(key);
        const initialDelay = previous.error ? Math.max(0, 5000 - (Date.now() - previous.attemptedAt))
            : previous.updatedAt == null ? 0 : Math.max(0, delay() - (Date.now() - previous.updatedAt));
        return startAuctionRefresh({
            refresh: () => cache.load(key, { maxAge: Math.min(5000, delay()) }),
            delay, document, initialDelay,
        });
    }, [cache, key, networkRequest, currentUser?.id]);

    useEffect(() => {
        if (!pendingKey) return;
        const previous = cache.snapshot(pendingKey);
        return startAuctionRefresh({
            refresh: () => cache.load(pendingKey, { maxAge: 5000 }),
            delay: 30000, document,
            initialDelay: previous.updatedAt == null ? 0 : Math.max(0, 30000 - (Date.now() - previous.updatedAt)),
        });
    }, [cache, pendingKey]);

    // Only explicit refreshes and completed/failed write attempts invalidate the
    // cache. A post-write refresh queues after any older read, so it cannot be
    // satisfied by a response whose request preceded the write.
    const refreshAuctions = useCallback(async () => {
        cache.invalidate();
        await cache.load(key, { force: true });
        if (pendingKey) await cache.load(pendingKey, { force: true });
    }, [cache, key, pendingKey]);

    const addAuction = async (auction) => {
        const id = await storage.create(auction);
        // A failed follow-up read must not turn a successful write into an
        // apparent failure and cause the user to submit the listing twice.
        await refreshAuctions();
        return id;
    };

    const placeBid = async (auctionId, amount) => {
        try {
            await storage.bid(auctionId, amount);
        } catch (failure) {
            await refreshAuctions();
            throw failure;
        }
        await refreshAuctions();
    };

    const confirmTrade = async (auctionId) => {
        try {
            await storage.confirmTrade(auctionId);
        } catch (failure) {
            await refreshAuctions();
            throw failure;
        }
        await refreshAuctions();
    };

    const rateTrade = async (auctionId, rating) => {
        await storage.rateTrade(auctionId, rating);
        await refreshAuctions();
    };

    const purchaseAuction = async (auctionId) => {
        try {
            await storage.purchase(auctionId);
        } catch (failure) {
            await refreshAuctions();
            throw failure;
        }
        await refreshAuctions();
    };

    const reserveBuyQuantity = async (auctionId, quantity) => {
        try {
            const reservation = await storage.reserveBuy(auctionId, quantity);
            await refreshAuctions();
            return reservation;
        } catch (failure) { await refreshAuctions(); throw failure; }
    };

    const cancelBuyReservation = async (reservationId) => {
        try {
            const result = await storage.cancelBuyReservation(reservationId);
            await refreshAuctions();
            return result;
        } catch (failure) { await refreshAuctions(); throw failure; }
    };

    const cancelAuction = async (auctionId) => {
        try {
            await storage.cancel(auctionId);
        } catch (failure) {
            await refreshAuctions();
            throw failure;
        }
        await refreshAuctions();
    };

    return (
        <AuctionsContext.Provider value={{ auctions, total, priceBounds, seller, isLoading, isRefreshing, hasLoaded, error, pendingTrades, pendingTotal, pendingPage, setPendingPage, pendingError, pendingHasLoaded, addAuction, placeBid, purchaseAuction, confirmTrade, rateTrade, reserveBuyQuantity, cancelBuyReservation, cancelAuction, refreshAuctions }}>
            {children}
        </AuctionsContext.Provider>
    );
};

AuctionsProvider.propTypes = { children: PropTypes.node.isRequired };
