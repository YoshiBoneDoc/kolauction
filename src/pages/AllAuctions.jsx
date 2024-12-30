import React, { useContext, useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { parseInput, convertToShorthand } from "../utils/numberUtils";

const AllAuctions = () => {
    const { auctions, updateAuction } = useContext(AuctionsContext);
    const { currentUser, logoutUser } = useContext(UserContext); // Added logoutUser

    // Memoize processed auctions with shorthand values
    const processedAuctions = useMemo(
        () =>
            auctions.map((auction) => ({
                ...auction,
                shorthandMinBid: convertToShorthand(auction.minBidMeat) || "0", // Precompute shorthand
                formattedQuantity: auction.quantity?.toLocaleString("en-US") || "0", // Format quantity with commas
            })),
        [auctions]
    );

    const calculateRemainingTime = (endTime) => {
        if (!endTime) return { timeString: "Invalid Auction Data", isRed: false };

        const currentTime = Date.now();
        const remainingTime = new Date(endTime) - currentTime;

        if (remainingTime <= 0) return { timeString: "Auction Expired", isExpired: true, isRed: false };

        const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);

        return {
            timeString: days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`,
            isExpired: false,
            isRed: remainingTime <= 3 * 60 * 60 * 1000,
        };
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

    const handlePlaceBid = (auctionId) => {
        const auction = auctions.find((a) => a.id === auctionId);
        const auctionOwner = String(auction.owner).trim().toLowerCase();
        const currentUsername = currentUser?.khubUsername?.trim().toLowerCase();

        // Check if the user is logged in
        if (!currentUsername) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: {
                    ...prevBids[auctionId],
                    bidError: "You must be logged in to place a bid.",
                },
            }));
            return;
        }

        // Check if the user is the owner of the auction
        if (auctionOwner === currentUsername) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: {
                    ...prevBids[auctionId],
                    bidError: "You cannot bid on your own auction.",
                },
            }));
            return;
        }

        // Show input field for valid users
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], showInput: true, bidError: "" },
        }));
    };

    useEffect(() => {
        const interval = setInterval(() => {
            setCountdowns(auctions.map((auction) => calculateRemainingTime(auction.endTime)));
        }, 1000);

        return () => clearInterval(interval);
    }, [auctions]);

    const formatNumber = (number) => number.toLocaleString("en-US");

    return (
        <div className="min-h-screen bg-[#DBE2EF] p-6">
            {/* User Section at the Top Right */}
            <div className="absolute top-6 right-6 flex flex-col items-end text-right">
                {currentUser ? (
                    <div className="flex flex-col items-end gap-1 text-right">
                        <span className="text-gray-700 text-sm font-bold">
                            Welcome,{" "}
                            <Link
                                to="/profile"
                                className="text-blue-500 hover:underline"
                            >
                                {currentUser.khubUsername}
                            </Link>
                        </span>
                        <button
                            onClick={logoutUser}
                            className="text-blue-500 hover:underline text-sm py-0.5 px-2"
                        >
                            Log Out
                        </button>
                    </div>
                ) : (
                    <Link to="/login" className="text-blue-500 hover:underline text-sm">
                        Log In
                    </Link>
                )}
            </div>

            {/* Navigation and Title */}
            <div className="mb-4">
                <Link
                    to="/"
                    className="text-[#112D4E] underline hover:text-[#3F72AF] text-sm"
                >
                    Home
                </Link>
            </div>

            <h1 className="text-4xl font-bold text-center text-[#112D4E] mb-8">All Auctions</h1>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {processedAuctions.map((auction, index) => (
                    <div
                        key={`${auction.id || 'auction'}-${index}`} // Ensure unique keys
                        className="border rounded-lg shadow-lg p-4 bg-[#F9F7F7] flex flex-col items-center"
                    >
                        {auction.image && (
                            <img
                                src={auction.image}
                                alt={auction.item}
                                className="w-32 h-32 object-contain mb-4"
                            />
                        )}
                        <h2 className="text-xl font-bold text-center mb-1">
                            <span className="text-[#112D4E]">{auction.item}</span>
                            <span className="text-[#3F72AF]"> x{auction.formattedQuantity}</span>
                        </h2>
                        <p className="text-xs text-[#3F72AF] mb-4">
                            Minimum Bid (Meat): {auction.shorthandMinBid}
                        </p>
                        <div className="text-center mb-4">
                            <p className="text-sm text-[#3F72AF] underline">Current Bid</p>
                            <p className="text-2xl font-extrabold text-[#112D4E]">
                                {auction.currentBid ? `${formatNumber(auction.currentBid)} Meat` : "No bids yet"}
                            </p>
                        </div>
                        <p
                            className={`text-xs text-center ${
                                countdowns[index]?.isRed ? "text-red-500" : "text-gray-500"
                            }`}
                        >
                            {countdowns[index]?.timeString || "Auction data error"}
                        </p>
                        {!countdowns[index]?.isExpired ? (
                            <div className="mt-4 w-full">
                                <Link
                                    to={`/auction/${auction.id}`}
                                    className="w-full bg-[#3F72AF] text-white font-bold py-2 px-4 rounded hover:bg-[#3F72AF] text-center block"
                                >
                                    More Info
                                </Link>
                            </div>
                        ) : (
                            <p className="text-red-500 text-center text-sm mt-4">
                                Auction Expired
                                {auction.currentBid
                                    ? ` | Winning Bid: ${formatNumber(auction.currentBid)}`
                                    : " | No bids"}
                            </p>
                        )}
                    </div>
                ))}            </div>
        </div>
    );
};

export default AllAuctions;