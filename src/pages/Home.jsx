import React, { useContext, useMemo, useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { convertToShorthand } from "../utils/numberUtils";

const Home = () => {
    const { auctions } = useContext(AuctionsContext);
    const { currentUser, logoutUser } = useContext(UserContext);
    const navigate = useNavigate();

    const [timers, setTimers] = useState({});
    const [showAll, setShowAll] = useState(false);

    // Process and sort popular auctions by the number of bids
    const popularAuctions = useMemo(() => {
        return auctions
            .map((auction) => ({
                ...auction,
                shorthandMinBid: convertToShorthand(auction.minBidMeat) || "0",
                formattedQuantity: auction.quantity?.toLocaleString("en-US") || "0",
                bidCount: auction.bids ? auction.bids.length : 0, // Calculate bid count
            }))
            .sort((a, b) => b.bidCount - a.bidCount); // Sort descending by bid count
    }, [auctions]);

    // Function to abbreviate large numbers for bids
    const formatBid = (amount) => {
        if (amount >= 1_000_000_000) {
            return `${(amount / 1_000_000_000).toFixed(2)} bil`; // Abbreviate to billions
        } else if (amount >= 1_000_000) {
            return `${(amount / 1_000_000).toFixed(2)} mil`; // Abbreviate to millions
        }
        return amount.toLocaleString("en-US"); // Default formatting
    };

    // Function to calculate remaining time and its display styling
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
            isRed: remainingTime <= 3 * 60 * 60 * 1000, // Red if less than 3 hours remaining
        };
    };

    // Update timers for all auctions
    useEffect(() => {
        const interval = setInterval(() => {
            const updatedTimers = {};
            popularAuctions.forEach((auction) => {
                updatedTimers[auction.id] = calculateRemainingTime(auction.endTime);
            });
            setTimers(updatedTimers);
        }, 1000);

        return () => clearInterval(interval); // Cleanup interval on unmount
    }, [popularAuctions]);

    // Get top 4 auctions or all auctions based on `showAll` state
    const displayedAuctions = showAll ? popularAuctions : popularAuctions.slice(0, 4);

    return (
        <div className="min-h-screen w-full bg-gray-50 flex flex-col"style={{ backgroundColor: "#F9F9F9" }}>
            {/* Static Header Section */}
            <header className="sticky top-0 z-50 bg-gray-50" style={{ backgroundColor: "#F9F9F9" }}>
                <div className="flex justify-center items-center gap-32 text-sm text-gray-500 pt-4 pb-2">
                    <div className="relative flex flex-col items-center">
                        <Link to="/auctions" className="text-[#FF9874] hover:text-[#C62300] flex-grow-0">
                            View All Auctions
                        </Link>
                        <div className="h-px bg-gray-300 w-20 mt-2"></div>
                    </div>
                    <div className="relative flex flex-col items-center flex-grow-0">
                        <Link to="/auction-item" className="text-[#FF9874] hover:text-[#C62300] flex-grow-0">
                            Auction an Item
                        </Link>
                        <div className="h-px bg-gray-300 w-20 mt-2"></div>
                    </div>
                    <div className="relative flex flex-col items-center flex-grow-0">
                        <Link to="/info" className="text-[#FF9874] hover:text-[#C62300] flex-grow-0">
                            Info
                        </Link>
                        <div className="h-px bg-gray-300 w-20 mt-2"></div>
                    </div>
                </div>

                {/* User Section */}
                <div className="absolute top-6 right-6 flex flex-col items-end text-right">
                    {currentUser ? (
                        <div className="flex flex-col items-end gap-1 text-right">
                            <span className="text-gray-700 text-sm font-bold">
                                Welcome,{" "}
                                <Link
                                    to="/profile"
                                    className="text-[#FE5F55] hover:underline"
                                >
                                    {currentUser.khubUsername}
                                </Link>
                            </span>
                            <button
                                onClick={logoutUser}
                                className="text-[#FE5F55] hover:underline text-sm py-0.5 px-2"
                            >
                                Log Out
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col items-end gap-1">
                            <Link to="/login" className="text-[#FE5F55] hover:underline text-sm">
                                Log In
                            </Link>
                            <Link to="/register" className="text-[#FE5F55] hover:underline text-sm">
                                Register
                            </Link>
                        </div>
                    )}
                </div>

                {/* Title Section */}
                <div className="text-center mt-3">
                    <h1 className="text-6xl font-extrabold"style={{ color: '#7695FF' }}>KoL Auction Hub <span className="text-sm">Beta</span></h1>
                    <p className="text-xl text-gray-700 mt-4">
                        The best place to find and bid on rare treasures.
                    </p>
                </div>
                <div className="flex justify-center mt-6 bg-gray-50 sticky top-[9rem] z-40">
                    <div className="border-t border-gray-300 w-2/3"></div>
                </div>
            </header>

            {/* Popular Items Section */}
            <div className="w-full max-w-6xl mx-auto px-4 mt-6">
                <h2 className="text-2xl font-bold text-gray-700 mb-4">Popular Items</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 pb-20">
                    {displayedAuctions.map((auction, index) => (
                        <div
                            key={`${auction.id || 'auction'}-${index}`} // Unique key using auction ID and index
                            onClick={() => navigate(`/auction/${auction.id}`)} // Make card clickable
                            className="flex items-center border rounded-md shadow p-2 bg-white cursor-pointer hover:shadow-lg transition-transform transform hover:scale-105"
                            style={{ backgroundColor: "#F8F6F4" }} // Tile background color
                        >
                            <img
                                src={auction.image || "/placeholder-icon.png"}
                                alt={auction.item}
                                className="w-10 h-10 object-contain mr-3"
                            />
                            <div className="flex flex-col flex-grow items-center text-center justify-center h-full">
                                <h2 className="text-lg font-bold text-[#14248A] break-words -mb-1.5">
                                    {auction.item}{" "}
                                    <span
                                        className="text-[#94A0F0] whitespace-nowrap">x{auction.formattedQuantity}</span>
                                </h2>
                                <p className="text-[11px] text-[#94A0F0] -mb-2.5 mt-3">
                                    Current Bid
                                </p>
                                <p className="text-lg font-extrabold text-[#112D4E] mt-1.5">
                                    {auction.currentBid
                                        ? `${formatBid(auction.currentBid)} Meat`
                                        : (
                                            <span className="text-gray-700">
                                <span className="font-bold">No Bids</span> - Min{" "}
                                                <span className="font-normal">{auction.shorthandMinBid}</span>
                            </span>
                                        )}
                                </p>
                                {/* Auction Timer */}
                                <p
                                    className={`mt-2 -mb-1 text-[11px]  ${
                                        timers[auction.id]?.isRed ? "text-red-500" : "text-gray-600"
                                    }`}
                                >
                                    Ends in: {timers[auction.id]?.timeString || "Invalid Data"}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
                {/* See More Button */}
                {!showAll && (
                    <div className="text-center mt-4">
                        <button
                            onClick={() => setShowAll(true)}
                            className="text-blue-500 underline text-sm"
                        >
                            See more
                        </button>
                    </div>
                )}
            </div>

            {/* Static Donate Bar */}
            <footer className="w-full bg-gray-100 border-t shadow-md py-2 fixed bottom-0">
                <div className="text-center">
                    <Link to="/donate" className="text-blue-500 text-sm hover:underline">
                        Donate
                    </Link>
                    <div className="text-[10px] text-gray-400 ml-auto flex justify-between ml-2.5">
                        All game images are copyright Asymmetric Publications from The Kingdom of Loathing
                    </div>
                </div>
            </footer>
        </div>
    );
};

export default Home;