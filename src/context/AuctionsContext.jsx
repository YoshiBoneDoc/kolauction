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
        {
            id: 12345,
            item: "Golden pubes",
            quantity: 1,
            minBidMeat: 1240000, // 1m
            auctionTime: 72, // 3 days in hours
            endTime: Date.now() + 72 * 60 * 60 * 1000, // Ends 3 days from now
            currentBid: 0,
            owner: "auctioneer123",
            image: "https://via.placeholder.com/150",
            bids: []
        },
        {
            id: 1,
            item: "Golden Sword",
            quantity: 10,
            minBidMeat: 1000000, // 1 million
            currentBid: 1500000, // 1.5 million
            endTime: Date.now() + 3600000, // 1 hour from now
            owner: "user123",
            image: "https://via.placeholder.com/150",
            bids: [
                { bidder: "user456", amount: 1500000, timestamp: Date.now() - 200000 },
            ],
        },
        {
            id: 2,
            item: "Enchanted Shield",
            quantity: 5,
            minBidMeat: 500000, // 500k
            currentBid: 0, // No bids yet
            endTime: Date.now() + 11200000, // 2 hours from now
            owner: "user789",
            image: "https://via.placeholder.com/150",
            bids: [],
        },
        {
            id: 3,
            item: "Potion of Immortality",
            quantity: 1,
            minBidMeat: 1000000000, // 1 billion
            currentBid: 1200000000, // 1.2 billion
            endTime: Date.now() - 5000, // Expired auction
            owner: "user123",
            image: "https://via.placeholder.com/150",
            bids: [
                { bidder: "user456", amount: 1100000000, timestamp: Date.now() - 3600000 },
                { bidder: "user789", amount: 1200000000, timestamp: Date.now() - 1800000 },
            ],
        },
        {
            id: 4,
            item: "Mystic Ring",
            quantity: 100,
            minBidMeat: 20000, // 20k
            currentBid: 30000, // 30k
            endTime: Date.now() + 10800000, // 3 hours from now
            owner: "user555",
            image: "https://via.placeholder.com/150",
            bids: [
                { bidder: "user789", amount: 30000, timestamp: Date.now() - 500000 },
            ],
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