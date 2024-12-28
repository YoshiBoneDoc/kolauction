import React, { useState, useContext } from "react";
import { AuctionsContext } from "../context/AuctionsContext";
import items from "../data/items.json";

const AuctionAnItem = () => {
    const { addAuction } = useContext(AuctionsContext);

    const [selectedItem, setSelectedItem] = useState("");
    const [quantity, setQuantity] = useState(1);
    const [mrACount, setMrACount] = useState(0);
    const [minBidMeat, setMinBidMeat] = useState("");
    const [auctionTime, setAuctionTime] = useState("24");
    const [showPreview, setShowPreview] = useState(false);

    const handleFormSubmit = (e) => {
        e.preventDefault();

        if (!selectedItem) {
            alert("Please select an item to auction.");
            return;
        }

        setShowPreview(true);
    };

    const handleConfirmAuction = () => {
        const endTime = Date.now() + auctionTime * 60 * 60 * 1000;

        const newAuction = {
            id: Date.now(),
            item: selectedItem,
            quantity,
            mrACount,
            minBidMeat: minBidMeat || 0,
            auctionTime,
            endTime,
            image: items.find((item) => item.name === selectedItem)?.image,
        };

        addAuction(newAuction);
        setShowPreview(false);
        alert("Auction submitted!");
    };

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <h1 className="text-4xl font-bold text-center text-blue-600 mb-8">Auction an Item</h1>
            <form onSubmit={handleFormSubmit} className="max-w-lg mx-auto bg-white shadow-md rounded px-8 pt-6 pb-8">
                <label htmlFor="item" className="block text-gray-700 text-sm font-bold mb-2">
                    Select an Item:
                </label>
                <select
                    id="item"
                    value={selectedItem}
                    onChange={(e) => setSelectedItem(e.target.value)}
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                >
                    <option value="" disabled>
                        Select an item
                    </option>
                    {items.map((item) => (
                        <option key={item.name} value={item.name}>
                            {item.name}
                        </option>
                    ))}
                </select>

                <label htmlFor="quantity" className="block text-gray-700 text-sm font-bold mb-2">
                    Quantity:
                </label>
                <input
                    id="quantity"
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    min="1"
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                />

                <label htmlFor="mrACount" className="block text-gray-700 text-sm font-bold mb-2">
                    Mr. A's (Optional):
                </label>
                <input
                    id="mrACount"
                    type="number"
                    value={mrACount}
                    onChange={(e) => setMrACount(Number(e.target.value))}
                    min="0"
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                />

                <label htmlFor="minBidMeat" className="block text-gray-700 text-sm font-bold mb-2">
                    Minimum Bid (Meat):
                </label>
                <input
                    id="minBidMeat"
                    type="number"
                    value={minBidMeat}
                    onChange={(e) => setMinBidMeat(Number(e.target.value))}
                    min="0"
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                />

                <label htmlFor="auctionTime" className="block text-gray-700 text-sm font-bold mb-2">
                    Auction Duration:
                </label>
                <select
                    id="auctionTime"
                    value={auctionTime}
                    onChange={(e) => setAuctionTime(e.target.value)}
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                >
                    <option value="6">6 Hours</option>
                    <option value="12">12 Hours</option>
                    <option value="24">1 Day</option>
                    <option value="72">3 Days</option>
                    <option value="168">7 Days</option>
                    <option value="720">1 Month</option>
                </select>

                <button
                    type="submit"
                    className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                >
                    Preview Auction
                </button>
            </form>

            {showPreview && (
                <div className="max-w-lg mx-auto bg-gray-100 shadow-md rounded mt-6 p-6">
                    <h2 className="text-2xl font-bold text-center mb-4">Preview Auction</h2>
                    {selectedItem && (
                        <div className="flex flex-col items-center">
                            <img
                                src={items.find((item) => item.name === selectedItem)?.image}
                                alt={selectedItem}
                                className="w-32 h-32 object-contain mb-4"
                            />
                            <p>Item: {selectedItem}</p>
                            <p>Quantity: {quantity}</p>
                            <p>Mr. A's: {mrACount}</p>
                            <p>Min Bid (Meat): {minBidMeat || 0}</p>
                            <p>Duration: {auctionTime} hours</p>
                        </div>
                    )}
                    <div className="flex justify-center mt-4">
                        <button
                            onClick={handleConfirmAuction}
                            className="bg-green-500 text-white font-bold py-2 px-4 rounded hover:bg-green-700 mx-2"
                        >
                            Confirm Auction
                        </button>
                        <button
                            onClick={() => setShowPreview(false)}
                            className="bg-red-500 text-white font-bold py-2 px-4 rounded hover:bg-red-700 mx-2"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AuctionAnItem;