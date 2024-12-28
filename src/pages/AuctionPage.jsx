import React, { useContext, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";

const AllAuctions = () => {
    const { auctions } = useContext(AuctionsContext);

    const calculateRemainingTime = (endTime, auctionDuration) => {
        if (!endTime || !auctionDuration) {
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

        let isRed = false;
        if (auctionDuration <= 24 && remainingTime <= 3 * 60 * 60 * 1000) {
            isRed = true;
        } else if (auctionDuration >= 72 && auctionDuration <= 168 && remainingTime <= 24 * 60 * 60 * 1000) {
            isRed = true;
        } else if (auctionDuration >= 720 && remainingTime <= 3 * 24 * 60 * 60 * 1000) {
            isRed = true;
        }

        return { timeString, isRed };
    };

    const [countdowns, setCountdowns] = useState(() =>
        auctions.map((auction) =>
            calculateRemainingTime(new Date(Date.now() + auction.auctionTime * 60 * 60 * 1000), auction.auctionTime)
        )
    );

    useEffect(() => {
        const interval = setInterval(() => {
            setCountdowns(
                auctions.map((auction) =>
                    calculateRemainingTime(new Date(auction.endTime), auction.auctionTime)
                )
            );
        }, 1000);

        return () => clearInterval(interval);
    }, [auctions]);

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

            <h1 className="text-4xl font-bold text-center text-blue-600 mb-8">All Auctions</h1>
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
                        <h2 className="text-2xl font-bold text-center mb-2">{auction.item}</h2>

                        {/* Details */}
                        <div className="text-sm text-gray-600 text-center">
                            <p>Quantity: {auction.quantity}</p>
                            <p>Min Bid (Meat): {auction.minBidMeat}</p>
                            <p>Mr. As: {auction.mrACount}</p>
                            <p>Current Bid: {auction.currentBid || "No bids yet"}</p>
                        </div>

                        {/* Countdown Timer */}
                        <p
                            className={`text-xs mt-4 text-center ${
                                countdowns[index]?.isRed ? "text-red-500" : "text-gray-500"
                            }`}
                        >
                            {countdowns[index]?.timeString || "Auction data error"}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default AllAuctions;