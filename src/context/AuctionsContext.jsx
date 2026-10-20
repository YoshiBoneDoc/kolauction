import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from 'react-router-dom';
import PropTypes from "prop-types";
import { supabase } from "../lib/supabase";
import { createAuctionService } from "../lib/auctions";
import { UserContext } from "./UserContext";
import { auctionReadRequest, auctionRefreshDelay, startAuctionRefresh } from '../lib/auctionRefresh';

export const AuctionsContext = createContext();
const storage = createAuctionService(supabase);

export const AuctionsProvider = ({ children }) => {
    const { currentUser, signedInUserId } = useContext(UserContext);
    const viewerId = signedInUserId === undefined ? currentUser?.id : signedInUserId;
    const { pathname, search } = useLocation();
    const request = useMemo(() => auctionReadRequest(pathname, search), [pathname, search]);
    const [pendingPage, setPendingPage] = useState(1);
    const showPending = Boolean(currentUser?.id && ['home', 'browse'].includes(request?.view));
    const key = JSON.stringify([request, viewerId, showPending ? pendingPage : null]);
    const sellerScope = request?.view === 'seller' ? JSON.stringify([request.id, viewerId ?? null]) : null;
    const [snapshot, setSnapshot] = useState(null);
    const requestVersion = useRef(0);
    const inFlight = useRef(null);
    const matches = snapshot?.key === key;
    const auctions = matches ? snapshot.auctions : [];
    const total = matches ? snapshot.total : 0;
    const seller = sellerScope && snapshot?.sellerScope === sellerScope ? snapshot.seller : null;
    const error = matches ? snapshot.error : '';
    const pendingTrades = matches ? snapshot.pendingTrades || [] : [];
    const pendingTotal = matches ? snapshot.pendingTotal || 0 : 0;
    const pendingError = matches ? snapshot.pendingError || '' : '';

    useEffect(() => {
        if (matches && !pendingError && pendingPage > Math.max(1, Math.ceil(pendingTotal / 12))) setPendingPage(Math.max(1, Math.ceil(pendingTotal / 12)));
    }, [matches, pendingError, pendingPage, pendingTotal]);
    const isLoading = Boolean(request && !matches);

    const refreshAuctions = useCallback(() => {
        if (!request || (request.view === 'profile' && !currentUser?.id)) return Promise.resolve();
        if (inFlight.current?.key === key) return inFlight.current.promise;
        const version = ++requestVersion.current;
        const readPending = () => showPending ? storage.pendingTrades(pendingPage).then(data => ({
            pendingTrades: data.auctions, pendingTotal: data.total, pendingError: '',
        })).catch(failure => ({ pendingTrades: [], pendingTotal: 0, pendingError: failure.message })) : Promise.resolve({});
        const promise = storage.load(request).then(async (data) => {
            // The main load closes expired auctions before reading personal trades.
            const pending = await readPending();
            if (version === requestVersion.current) setSnapshot({ key, sellerScope, ...data, ...pending, error: '' });
        }).catch((failure) => {
            if (version === requestVersion.current) setSnapshot((previous) => ({
                key, sellerScope, auctions: previous?.key === key ? previous.auctions : [],
                total: previous?.key === key ? previous.total : 0, error: failure.message,
                seller: sellerScope && previous?.sellerScope === sellerScope ? previous.seller : null,
                pendingTrades: previous?.key === key ? previous.pendingTrades : [],
                pendingTotal: previous?.key === key ? previous.pendingTotal : 0,
                pendingError: showPending ? failure.message : '',
            }));
        }).finally(() => {
            if (inFlight.current?.promise === promise) inFlight.current = null;
        });
        inFlight.current = { key, promise };
        return promise;
    }, [request, key, sellerScope, currentUser?.id, showPending, pendingPage]);

    useEffect(() => {
        const requests = requestVersion;
        if (!request || (request.view === 'profile' && !currentUser?.id)) return;
        const stop = startAuctionRefresh({
            refresh: refreshAuctions, delay: auctionRefreshDelay(request), document, window,
            initialDelay: ['browse', 'seller'].includes(request.view) && request.search ? 250 : 0,
        });
        return () => {
            ++requests.current;
            inFlight.current = null;
            stop();
        };
    }, [refreshAuctions, request, currentUser?.id]);

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

    const purchaseAuction = async (auctionId) => {
        try {
            await storage.purchase(auctionId);
        } catch (failure) {
            await refreshAuctions();
            throw failure;
        }
        await refreshAuctions();
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
        <AuctionsContext.Provider value={{ auctions, total, seller, isLoading, error, pendingTrades, pendingTotal, pendingPage, setPendingPage, pendingError, addAuction, placeBid, purchaseAuction, confirmTrade, cancelAuction, refreshAuctions }}>
            {error && (
                <div role="alert" className="bg-red-50 text-red-700 p-4">
                    {error}{" "}
                    <button onClick={refreshAuctions} className="underline">Retry</button>
                </div>
            )}
            {children}
        </AuctionsContext.Provider>
    );
};

AuctionsProvider.propTypes = { children: PropTypes.node.isRequired };
