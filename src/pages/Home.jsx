import React, { useContext, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { convertToShorthand } from "../utils/numberUtils";

const Home = () => {
    const { auctions } = useContext(AuctionsContext);
    const { currentUser, logoutUser } = useContext(UserContext);
    const navigate = useNavigate();

    // Process popular auctions with shorthand values
    const popularAuctions = useMemo(() =>
            auctions.slice(0, 4).map((auction) => ({
                ...auction,
                shorthandMinBid: convertToShorthand(auction.minBidMeat) || "0",
                formattedQuantity: auction.quantity?.toLocaleString("en-US") || "0",
            }))
        , [auctions]);

    return (
        <div className="min-h-screen w-full bg-gray-50 flex flex-col">
            {/* Header Section */}
            <header className="relative mb-10 mt-12">
                {/* User Section */}
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
                                className="text-blue-500 hover:underline text-sm"
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

                {/* Title Section */}
                <div className="text-center">
                    <h1 className="text-6xl font-extrabold text-blue-600">KoL Auction Bay</h1>
                    <p className="text-xl text-gray-700 mt-4">
                        The best place to find and bid on rare treasures.
                    </p>
                </div>

                {/* Navigation Links */}
                <nav className="flex justify-center gap-12 mt-6 -mb-14 text-sm text-gray-500">
                    {!currentUser && (
                        <Link to="/register" className="hover:underline">
                            Register
                        </Link>
                    )}
                    <Link to="/auctions" className="hover:underline">
                        View All Auctions
                    </Link>
                    <Link to="/auction-item" className="hover:underline">
                        Auction an Item
                    </Link>
                    <Link to="/info" className="hover:underline">
                        Info
                    </Link>
                </nav>
            </header>

            {/* Divider Line */}
            <div className="flex justify-center mt-6">
                <div className="border-t border-gray-300 w-2/3"></div>
            </div>

            {/* Scrollable Cards Section */}
            <div className="flex-grow overflow-y-auto w-full max-w-6xl mx-auto px-4 mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {popularAuctions.map((auction) => (
                        <div
                            key={auction.id}
                            onClick={() => navigate(`/auction/${auction.id}`)} // Make card clickable
                            className="flex items-center border rounded-md shadow p-2 bg-white cursor-pointer hover:shadow-lg transition-transform transform hover:scale-105"
                        >
                            {/* Icon or Item Image */}
                            <img
                                src={auction.image || "/placeholder-icon.png"}
                                alt={auction.item}
                                className="w-10 h-10 object-contain mr-3"
                            />

                            {/* Item Details */}
                            <div className="flex flex-col flex-grow text-center">
                                <h2 className="text-lg font-bold text-[#112D4E]">
                                    {auction.item} <span className="text-[#3F72AF]">x{auction.formattedQuantity}</span>
                                </h2>
                                <p className="text-sm text-blue-500 underline mt-1">Current Bid</p>
                                <p className="text-lg font-extrabold text-[#112D4E] mt-1">
                                    {auction.currentBid
                                        ? `${auction.currentBid.toLocaleString("en-US")} Meat`
                                        : <span className="text-gray-700"><span className="font-bold">No Bids</span> - Min <span className="font-normal">{auction.shorthandMinBid}</span></span>}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Static Donate Bar */}
            <footer className="w-full bg-gray-100 border-t shadow-md py-2 fixed bottom-0">
                <div className="text-center">
                    <Link
                        to="/donate"
                        className="text-blue-500 text-sm hover:underline"
                    >
                        Donate
                    </Link>
                </div>
            </footer>
        </div>
    );
};

export default Home;