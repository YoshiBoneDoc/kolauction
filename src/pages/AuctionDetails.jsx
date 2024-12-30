import React, { useContext, useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { parseInput } from "../utils/numberUtils.jsx";

const AuctionDetails = () => {
    const { id } = useParams();
    const { auctions, updateAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);

    const auction = auctions.find((auction) => String(auction.id) === String(id));

    const [bidAmount, setBidAmount] = useState("");
    const [bidError, setBidError] = useState("");
    const [remainingTime, setRemainingTime] = useState("");

    // Format numbers for display
    const formattedMinBid = useMemo(
        () => auction?.minBidMeat?.toLocaleString("en-US") || "0",
        [auction?.minBidMeat]
    );

    const formattedCurrentBid = useMemo(
        () => (auction?.currentBid?.toLocaleString("en-US") || "No bids yet"),
        [auction?.currentBid]
    );

    // Calculate the remaining time for the auction
    const calculateRemainingTime = (endTime) => {
        if (!endTime) return "Expired";

        const timeDifference = new Date(endTime) - Date.now();
        if (timeDifference <= 0) return "Expired";

        const hours = Math.floor(timeDifference / (1000 * 60 * 60));
        const minutes = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDifference % (1000 * 60)) / 1000);

        return `${hours}h ${minutes}m ${seconds}s`;
    };

    useEffect(() => {
        if (!auction?.endTime) return;

        const interval = setInterval(() => {
            setRemainingTime(calculateRemainingTime(auction.endTime));
        }, 1000);

        return () => clearInterval(interval);
    }, [auction?.endTime]);

    // Handle bid input with cursor management and 20 billion cap
    const handleBidInputChange = (e) => {
        const inputElement = document.activeElement;
        if (!inputElement) return;

        const value = e.target.value;
        const rawValue = value.replace(/,/g, "");
        const cursorPosition = inputElement.selectionStart;

        // Cap the value at 20 billion
        const maxAmount = 20000000000;
        if (parseInt(rawValue, 10) > maxAmount) {
            return;
        }

        // Count numeric digits up to the cursor position (ignoring commas)
        let digitsBeforeCursor = 0;
        for (let i = 0; i < cursorPosition; i++) {
            if (/\d/.test(value[i])) {
                digitsBeforeCursor++;
            }
        }

        // Format the value with commas
        const formattedValue = rawValue.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

        // Calculate the new cursor position
        let newCursorPosition = 0;
        let digitCount = 0;
        for (let i = 0; i < formattedValue.length; i++) {
            if (/\d/.test(formattedValue[i])) {
                digitCount++;
            }
            if (digitCount === digitsBeforeCursor) {
                newCursorPosition = i + 1;
                break;
            }
        }

        // Update the state with the formatted value
        setBidAmount(formattedValue);

        // Restore the cursor position after formatting
        requestAnimationFrame(() => {
            inputElement.setSelectionRange(newCursorPosition, newCursorPosition);
        });
    };

    // Handle bid submission
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
            setBidError("");
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
            <div className="mb-6">
                <Link to="/auctions" className="text-blue-500 underline hover:text-blue-700 text-sm">
                    Back to Auctions
                </Link>
            </div>

            <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
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
                                    onChange={handleBidInputChange}
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

                    <div className="flex flex-col justify-between">
                        <div className="text-center">
                            <h1 className="text-4xl font-bold text-blue-600 mb-2">
                                {auction.item}{" "}
                                <span className="text-xl text-gray-600">
                                    x {auction.quantity.toLocaleString("en-US")}
                                </span>
                            </h1>
                            <p className="text-xs text-gray-500 mb-6">
                                Minimum Bid (Meat): {formattedMinBid}
                            </p>
                            <p className="text-sm text-gray-500 underline mt-10">Current Bid</p>
                            <p className="text-3xl font-extrabold text-black mt-2">{formattedCurrentBid} Meat</p>
                            <p className="text-sm text-gray-600 mt-16">Sold by: <span className="font-bold text-black">{auction.owner || "Unknown"}</span>
                            </p>
                        </div>

                        <p className="text-xs text-gray-500 mt-6 text-center">Ends In: {remainingTime}</p>
                    </div>
                </div>
            </div>

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
                                            {bid.amount.toLocaleString("en-US")} Meat
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