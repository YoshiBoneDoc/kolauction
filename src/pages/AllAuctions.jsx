import React, { useContext, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";

const AllAuctions = () => {
    const { auctions, updateAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);

    const calculateRemainingTime = (endTime) => {
        if (!endTime) {
            return { timeString: "Invalid Auction Data", isRed: false };
        }

        const currentTime = Date.now();
        const remainingTime = new Date(endTime) - currentTime;

        if (remainingTime <= 0) {
            return { timeString: "Auction Ended", isRed: false };
        }

        const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);

        const timeString =
            days > 0
                ? `${days}d ${hours}h ${minutes}m`
                : `${hours}h ${minutes}m ${seconds}s`;

        return { timeString, isRed: remainingTime <= 3 * 60 * 60 * 1000 };
    };

    const [countdowns, setCountdowns] = useState(() =>
        auctions.map((auction) => calculateRemainingTime(auction.endTime))
    );

    const [bids, setBids] = useState(() =>
        auctions.reduce((acc, auction) => {
            acc[auction.id] = { bidAmount: "", bidError: "", showInput: false };
            return acc;
        }, {})
    );

    useEffect(() => {
        const interval = setInterval(() => {
            setCountdowns(
                auctions.map((auction) => calculateRemainingTime(auction.endTime))
            );
        }, 1000);

        return () => clearInterval(interval);
    }, [auctions]);

    const formatNumber = (number) =>
        number.toLocaleString("en-US");

    const handlePlaceBid = (auctionId) => {
        if (!currentUser) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "Only registered users may bid." },
            }));
            return;
        }

        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], showInput: true, bidError: "" },
        }));
    };

    const handleBidConfirm = (auctionId) => {
        const { bidAmount } = bids[auctionId];
        const numericBid = parseInt(bidAmount.replace(/,/g, ""), 10);
        const auction = auctions.find((a) => a.id === auctionId);

        if (numericBid > (auction.currentBid || 0) && numericBid >= auction.minBidMeat) {
            const updatedAuction = { ...auction, currentBid: numericBid };
            updateAuction(updatedAuction);

            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { bidAmount: "", bidError: "", showInput: false },
            }));
        } else {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "Bid too low" },
            }));
        }
    };

    const handleInputChange = (auctionId, value) => {
        const formattedValue = value.replace(/\D/g, ""); // Allow only numbers
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], bidAmount: formatNumber(formattedValue) },
        }));
    };

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            {/* Home Button */}
            <div className="mb-4">
                <Link
                    to="/"
                    className="text-blue-500 underline hover:text-blue-700 text-sm"
                >
                    Home
                </Link>
            </div>

            <h1 className="text-4xl font-bold text-center text-blue-600 mb-8">
                All Auctions
            </h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {auctions.map((auction, index) => (
                    <div
                        key={auction.id}
                        className="border rounded-lg shadow-lg p-4 bg-white flex flex-col items-center"
                    >
                        {/* Image */}
                        {auction.image && (
                            <img
                                src={auction.image}
                                alt={auction.item}
                                className="w-32 h-32 object-contain mb-4"
                            />
                        )}

                        {/* Item Name */}
                        <h2 className="text-2xl font-bold text-center mb-2">
                            {auction.item}
                        </h2>

                        {/* Details */}
                        <div className="text-sm text-gray-600 text-center">
                            <p>Quantity: {auction.quantity}</p>
                            <p>Min Bid (Meat): {formatNumber(auction.minBidMeat)}</p>
                            <p>Mr. As: {auction.mrACount}</p>
                            <p>
                                Current Bid:{" "}
                                {auction.currentBid
                                    ? formatNumber(auction.currentBid)
                                    : "No bids yet"}
                            </p>
                        </div>

                        {/* Countdown Timer */}
                        <p
                            className={`text-xs mt-4 text-center ${
                                countdowns[index]?.isRed
                                    ? "text-red-500"
                                    : "text-gray-500"
                            }`}
                        >
                            {countdowns[index]?.timeString || "Auction data error"}
                        </p>

                        {/* Bid Section */}
                        {currentUser ? (
                            auction.owner === currentUser.khubUsername ? (
                                <p className="text-gray-500 text-sm mt-4">
                                    You cannot bid on your own auction.
                                </p>
                            ) : (
                                <div className="mt-4 w-full">
                                    {!bids[auction.id].showInput ? (
                                        <button
                                            onClick={() => handlePlaceBid(auction.id)}
                                            className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                                        >
                                            Place Bid
                                        </button>
                                    ) : (
                                        <>
                                            <input
                                                type="text"
                                                value={bids[auction.id]?.bidAmount || ""}
                                                onChange={(e) =>
                                                    handleInputChange(auction.id, e.target.value)
                                                }
                                                placeholder="Bid Meat"
                                                className="w-full p-2 border border-gray-300 rounded placeholder-gray-500"
                                            />
                                            <button
                                                onClick={() => handleBidConfirm(auction.id)}
                                                className="w-full bg-blue-500 text-white font-bold py-2 px-4 mt-2 rounded hover:bg-blue-700"
                                            >
                                                Confirm
                                            </button>
                                        </>
                                    )}
                                    {bids[auction.id]?.bidError && (
                                        <p className="text-red-500 text-center text-sm mt-2">
                                            {bids[auction.id]?.bidError}
                                        </p>
                                    )}
                                </div>
                            )
                        ) : (
                            <p className="text-red-500 text-center text-sm mt-4">
                                Only registered users may bid.
                            </p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default AllAuctions;