import React, { createContext, useState } from "react";

// Create the AuctionsContext
export const AuctionsContext = createContext();

// Create the AuctionsProvider component
export const AuctionsProvider = ({ children }) => {
    const [auctions, setAuctions] = useState([]);

    // Function to add a new auction
    const addAuction = (newAuction) => {
        setAuctions((prevAuctions) => [...prevAuctions, newAuction]);
    };

    // Function to update an auction with new bid
    const updateAuction = (updatedAuction) => {
        setAuctions((prevAuctions) =>
            prevAuctions.map((auction) =>
                auction.id === updatedAuction.id ? updatedAuction : auction
            )
        );
    };

    // Function to handle a new bid
    const handleBid = (auctionId, newBid, bidder) => {
        setAuctions((prevAuctions) =>
            prevAuctions.map((auction) => {
                if (auction.id === auctionId) {
                    if (newBid > (auction.currentBid || 0) && newBid >= auction.minBidMeat) {
                        return {
                            ...auction,
                            currentBid: newBid,
                            highestBidder: bidder,
                        };
                    }
                }
                return auction;
            })
        );
    };

    return (
        <AuctionsContext.Provider
            value={{
                auctions,
                addAuction,
                updateAuction,
                handleBid, // Expose handleBid function
            }}
        >
            {children}
        </AuctionsContext.Provider>
    );
};