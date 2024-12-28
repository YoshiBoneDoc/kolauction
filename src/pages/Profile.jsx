import React, { useContext } from "react";
import { UserContext } from "../context/UserContext";
import { AuctionsContext } from "../context/AuctionsContext";
import { Link } from "react-router-dom";

const Profile = () => {
    const { currentUser } = useContext(UserContext);
    const { auctions } = useContext(AuctionsContext);

    if (!currentUser) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
                <p className="text-red-500 text-xl font-bold mb-4">You must be logged in to view your profile.</p>
                <Link to="/login" className="text-blue-500 hover:underline text-lg">
                    Log In
                </Link>
            </div>
        );
    }

    const userAuctions = auctions.filter(auction => auction.seller === currentUser.khubUsername);
    const userBids = auctions.filter(auction =>
        auction.bids?.some(bid => bid.bidder === currentUser.khubUsername)
    );

    const completedAuctions = userAuctions.filter(auction => new Date(auction.endTime) < Date.now());
    const completedBids = userBids.filter(auction => new Date(auction.endTime) < Date.now());

    const totalMeatGain = completedAuctions.reduce(
        (sum, auction) => sum + (auction.currentBid || 0),
        0
    );
    const totalMeatBid = completedBids.reduce((sum, auction) => {
        const userBid = auction.bids.find(bid => bid.bidder === currentUser.khubUsername);
        return sum + (userBid?.amount || 0);
    }, 0);

    const formatNumber = (number) => number.toLocaleString("en-US");

    return (
        <div className="min-h-screen bg-gray-50 p-6 pb-20">
            <div className="mb-6">
                <Link
                    to="/"
                    className="text-blue-500 underline hover:text-blue-700 text-sm"
                >
                    Home
                </Link>
            </div>

            <h1 className="text-4xl font-bold text-blue-600 mb-6 text-center">
                {currentUser.khubUsername}'s Profile
            </h1>

            {/* Main Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Current Section */}
                <div>
                    <h2 className="text-2xl font-bold text-gray-800 mb-4 border-b border-gray-300 pb-2">Current</h2>
                    <div className="flex">
                        {/* Current Auctions */}
                        <div className="w-1/2 pr-6 border-r border-gray-300">
                            <h3 className="text-xl font-semibold text-gray-700 mb-2">
                                Current Auctions
                            </h3>
                            {userAuctions.length > 0 ? (
                                <div className="space-y-4">
                                    {userAuctions.map(auction => (
                                        <div
                                            key={auction.id}
                                            className="border rounded-lg shadow-lg p-4 bg-white"
                                        >
                                            <h4 className="text-lg font-bold">{auction.item}</h4>
                                            <p>Quantity: {auction.quantity}</p>
                                            <p>Min Bid: {formatNumber(auction.minBidMeat)}</p>
                                            <p>Current Bid: {auction.currentBid ? formatNumber(auction.currentBid) : "No bids yet"}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-gray-600">No current auctions.</p>
                            )}
                        </div>

                        {/* Current Bids */}
                        <div className="w-1/2 pl-6">
                            <h3 className="text-xl font-semibold text-gray-700 mb-2">
                                Current Bids
                            </h3>
                            {userBids.length > 0 ? (
                                <div className="space-y-4">
                                    {userBids.map(auction => (
                                        <div
                                            key={auction.id}
                                            className="border rounded-lg shadow-lg p-4 bg-white"
                                        >
                                            <h4 className="text-lg font-bold">{auction.item}</h4>
                                            <p>Your Bid: {formatNumber(auction.bids.find(bid => bid.bidder === currentUser.khubUsername)?.amount || 0)}</p>
                                            <p>Current Bid: {auction.currentBid ? formatNumber(auction.currentBid) : "No bids yet"}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-gray-600">No current bids.</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* History Section */}
                <div>
                    <h2 className="text-2xl font-bold text-gray-800 mb-4 border-b border-gray-300 pb-2">History</h2>
                    <div className="flex">
                        {/* Auction History */}
                        <div className="w-1/2 pr-6 border-r border-gray-300">
                            <h3 className="text-xl font-semibold text-gray-700 mb-2">
                                Auction History
                            </h3>
                            {completedAuctions.length > 0 ? (
                                <div className="space-y-4">
                                    {completedAuctions.map(auction => (
                                        <div
                                            key={auction.id}
                                            className="border rounded-lg shadow-lg p-4 bg-gray-100"
                                        >
                                            <h4 className="text-lg font-bold">{auction.item}</h4>
                                            <p>Final Price: {formatNumber(auction.currentBid || 0)}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-gray-600">No completed auctions.</p>
                            )}
                        </div>

                        {/* Bid History */}
                        <div className="w-1/2 pl-6">
                            <h3 className="text-xl font-semibold text-gray-700 mb-2">
                                Bid History
                            </h3>
                            {completedBids.length > 0 ? (
                                <div className="space-y-4">
                                    {completedBids.map(auction => (
                                        <div
                                            key={auction.id}
                                            className="border rounded-lg shadow-lg p-4 bg-gray-100"
                                        >
                                            <h4 className="text-lg font-bold">{auction.item}</h4>
                                            <p>Your Bid: {formatNumber(auction.bids.find(bid => bid.bidder === currentUser.khubUsername)?.amount || 0)}</p>
                                            <p>Winning Bid: {formatNumber(auction.currentBid || 0)}</p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-gray-600">No completed bids.</p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Profile;