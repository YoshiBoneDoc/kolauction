import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { supabase } from "../lib/supabase";
import { createAuctionService } from "../lib/auctions";
import { UserContext } from "./UserContext";

export const AuctionsContext = createContext();
const storage = createAuctionService(supabase);

export const AuctionsProvider = ({ children }) => {
    const { currentUser } = useContext(UserContext);
    const [auctions, setAuctions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const requestVersion = useRef(0);

    const refreshAuctions = useCallback(async () => {
        const version = ++requestVersion.current;
        try {
            const data = await storage.load();
            if (version === requestVersion.current) {
                setAuctions(data);
                setError("");
            }
        } catch (failure) {
            if (version === requestVersion.current) setError(failure.message);
        } finally {
            if (version === requestVersion.current) setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        const requests = requestVersion;
        refreshAuctions();
        // Also refresh across browsers and on returning to this tab. No
        // Realtime publication setup is required for persistence.
        const interval = setInterval(refreshAuctions, 10000);
        window.addEventListener("focus", refreshAuctions);
        return () => {
            ++requests.current;
            clearInterval(interval);
            window.removeEventListener("focus", refreshAuctions);
        };
    }, [refreshAuctions, currentUser?.id]);

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
        <AuctionsContext.Provider value={{ auctions, isLoading, error, addAuction, placeBid, confirmTrade, cancelAuction, refreshAuctions }}>
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
