import React, { createContext, useState } from "react";
import PropTypes from "prop-types";

// Create the AuctionsContext
export const AuctionsContext = createContext();

// Create the AuctionsProvider component
export const AuctionsProvider = ({ children }) => {
AuctionsProvider.propTypes = {
    children: PropTypes.node.isRequired,
};
    const [auctions, setAuctions] = useState([
        {
            id: "test-auction-1",
            item: "Golden Sword",
            quantity: 1,
            minBidMeat: 5000,
            mrACount: 2,
            currentBid: 7000,
            bids: [
                { bidder: "user1", amount: 6000, timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
                { bidder: "user2", amount: 7000, timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() },
            ],
            endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            owner: "ting", // Example username
            image: "https://via.placeholder.com/150", // Placeholder image
        },
    ]);

    // Function to add a new auction
    const addAuction = (newAuction) => {
        if (!newAuction.owner) {
            console.error("Owner field is missing in the new auction:", newAuction);
        }
        setAuctions((prevAuctions) => [...prevAuctions, newAuction]);
    };

    // Function to update an auction
    const updateAuction = (updatedAuction) => {
        setAuctions((prevAuctions) =>
            prevAuctions.map((auction) =>
                auction.id === updatedAuction.id
                    ? { ...auction, ...updatedAuction, owner: auction.owner }
                    : auction
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
                            owner: auction.owner, // Ensure owner is preserved
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
                handleBid,
            }}
        >
            {children}
        </AuctionsContext.Provider>
    );
};