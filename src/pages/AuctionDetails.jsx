import React, { useContext, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";

const AuctionDetails = () => {
    const { id } = useParams();
    const { auctions, updateAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);

    const auction = auctions.find((auction) => String(auction.id) === String(id));

    const [bidAmount, setBidAmount] = useState("");
    const [bidError, setBidError] = useState("");

    const formatNumber = (number) => number.toLocaleString("en-US");

    const handleBidSubmit = () => {
        if (!currentUser) {
            setBidError("Only registered users may bid.");
            return;
        }

        const numericBid = parseInt(bidAmount.replace(/,/g, ""), 10);

        if (isNaN(numericBid) || numericBid <= 0) {
            setBidError("Please enter a valid bid amount.");
            return;
        }

        if (auction.owner === currentUser.khubUsername) {
            setBidError("You cannot bid on your own auction.");
            return;
        }

        if (numericBid > (auction.currentBid || 0) && numericBid >= auction.minBidMeat) {
            const updatedAuction = {
                ...auction,
                currentBid: numericBid,
                bids: [
                    ...(auction.bids || []),
                    { bidder: currentUser.khubUsername, amount: numericBid, timestamp: Date.now() },
                ],
            };
            updateAuction(updatedAuction);
            setBidAmount("");
            setBidError(""); // Clear error on successful bid
        } else {
            setBidError("Bid too low.");
        }
    };

    if (!auction) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
                <p className="text-red-500 text-xl font-bold mb-4">Auction not found.</p>
                <Link to="/auctions" className="text-blue-500 hover:underline text-lg">
                    Back to Auctions
                </Link>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            {/* Back to Auctions Button */}
            <div className="mb-6">
                <Link
                    to="/auctions"
                    className="text-blue-500 underline hover:text-blue-700 text-sm"
                >
                    Back to Auctions
                </Link>
            </div>

            {/* Auction Details */}
            <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Left Section: Image and Place Bid */}
                    <div className="flex flex-col items-center">
                        {auction.image ? (
                            <img
                                src={auction.image}
                                alt={auction.item}
                                className="w-48 h-48 object-contain mb-4"
                            />
                        ) : (
                            <div className="w-48 h-48 flex items-center justify-center bg-gray-100 rounded-lg mb-4">
                                <p className="text-gray-500">No Image Available</p>
                            </div>
                        )}

                        {currentUser && (
                            <>
                                <input
                                    type="text"
                                    value={bidAmount}
                                    onChange={(e) => setBidAmount(e.target.value.replace(/\D/g, ""))}
                                    placeholder="Enter your bid"
                                    className="w-full p-2 border border-gray-300 rounded text-center placeholder-gray-500 mb-2 text-sm"
                                />
                                <button
                                    onClick={handleBidSubmit}
                                    className="bg-blue-500 text-white font-bold py-1 px-3 rounded hover:bg-blue-700 text-sm"
                                >
                                    Place Bid
                                </button>
                                {bidError && (
                                    <p className="text-red-500 text-center text-xs mt-2">{bidError}</p>
                                )}
                            </>
                        )}
                    </div>

                    {/* Right Section: Item Details */}
                    <div className="flex flex-col justify-between">
                        <div className="text-center">
                            <h1 className="text-4xl font-bold text-blue-600 mb-2">
                                {auction.item} <span className="text-xl text-gray-600">x {auction.quantity}</span>
                            </h1>
                            <p className="text-xs text-gray-500 mb-6">
                                Minimum Bid (Meat): {formatNumber(auction.minBidMeat)}
                            </p>

                            <p className="text-sm text-gray-500 underline">Current Bid</p>
                            <p className="text-3xl font-extrabold text-black">
                                {auction.currentBid ? `${formatNumber(auction.currentBid)} Meat` : "No bids yet"}
                            </p>
                            <p className="text-sm text-gray-600 mt-2">Seller: {auction.owner || "Unknown"}</p>
                        </div>

                        <p className="text-xs text-gray-500 mt-6 text-center">
                            Ends In: {new Date(auction.endTime) - Date.now() > 0
                            ? `${Math.floor((new Date(auction.endTime) - Date.now()) / (1000 * 60 * 60))}h 
        ${Math.floor(((new Date(auction.endTime) - Date.now()) % (1000 * 60 * 60)) / (1000 * 60))}m 
       ${Math.floor(((new Date(auction.endTime) - Date.now()) % (1000 * 60)) / 1000)}s`
                            : "Expired"}
                        </p>
                    </div>
                </div>
            </div>

            {/* Bid History */}
            <div className="max-w-4xl mx-auto bg-gray-50 mt-8 p-6 rounded-lg shadow">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Bid History</h2>
                {auction.bids && auction.bids.length > 0 ? (
                    <ul className="divide-y divide-gray-200">
                        {auction.bids
                            .slice()
                            .reverse()
                            .map((bid, index) => (
                                <li key={index} className="py-4 flex justify-between items-center">
                                    <span className="text-gray-700 font-medium">{bid.bidder}</span>
                                    <div className="text-right">
                        <span className="text-gray-900 font-bold">
                            {formatNumber(bid.amount)} Meat
                        </span>
                                        <br />
                                        <span className="text-gray-500 text-xs">
                            {new Date(bid.timestamp).toLocaleString()}
                        </span>
                                    </div>
                                </li>
                            ))}
                    </ul>
                ) : (
                    <p className="text-gray-600">No bids yet.</p>
                )}
            </div>
        </div>
    );
};

export default AuctionDetails;