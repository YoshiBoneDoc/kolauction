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

    return (
        <AuctionsContext.Provider value={{ auctions, addAuction }}>
            {children}
        </AuctionsContext.Provider>
    );
};