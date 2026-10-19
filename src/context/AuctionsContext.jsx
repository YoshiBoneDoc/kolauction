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
    const { currentUser } = useContext(UserContext);
    const { pathname, search } = useLocation();
    const request = useMemo(() => auctionReadRequest(pathname, search), [pathname, search]);
    const key = JSON.stringify([request, currentUser?.id]);
    const [snapshot, setSnapshot] = useState(null);
    const requestVersion = useRef(0);
    const inFlight = useRef(null);
    const matches = snapshot?.key === key;
    const auctions = matches ? snapshot.auctions : [];
    const total = matches ? snapshot.total : 0;
    const error = matches ? snapshot.error : '';
    const isLoading = Boolean(request && !matches);

    const refreshAuctions = useCallback(() => {
        if (!request || (request.view === 'profile' && !currentUser?.id)) return Promise.resolve();
        if (inFlight.current?.key === key) return inFlight.current.promise;
        const version = ++requestVersion.current;
        const promise = storage.load(request).then((data) => {
            if (version === requestVersion.current) setSnapshot({ key, ...data, error: '' });
        }).catch((failure) => {
            if (version === requestVersion.current) setSnapshot((previous) => ({
                key, auctions: previous?.key === key ? previous.auctions : [],
                total: previous?.key === key ? previous.total : 0, error: failure.message,
            }));
        }).finally(() => {
            if (inFlight.current?.promise === promise) inFlight.current = null;
        });
        inFlight.current = { key, promise };
        return promise;
    }, [request, key, currentUser?.id]);

    useEffect(() => {
        const requests = requestVersion;
        if (!request || (request.view === 'profile' && !currentUser?.id)) return;
        const stop = startAuctionRefresh({
            refresh: refreshAuctions, delay: auctionRefreshDelay(request), document, window,
            initialDelay: request.view === 'browse' && request.search ? 250 : 0,
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
        <AuctionsContext.Provider value={{ auctions, total, isLoading, error, addAuction, placeBid, purchaseAuction, confirmTrade, cancelAuction, refreshAuctions }}>
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
