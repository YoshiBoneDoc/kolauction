import React from "react";

const AuctionPage = () => {
    return (
        <div className="p-6">
            <h1 className="text-4xl font-bold mb-4">Auction Item Name</h1>
            <p className="text-lg mb-4">
                Description of the auction item goes here. This will explain what the item is about.
            </p>
            <p className="text-xl font-semibold mb-6">Current Bid: $0</p>
            <button className="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600">
                Place Bid
            </button>
        </div>
    );
};

export default AuctionPage;