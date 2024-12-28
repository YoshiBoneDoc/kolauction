import React, { useContext } from "react";
import { Link } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";

const Home = () => {
    const { auctions } = useContext(AuctionsContext);
    const { currentUser, logoutUser } = useContext(UserContext);

    return (
        <div className="min-h-screen w-full bg-gray-50 flex flex-col justify-between py-10">
            <header className="mb-12 relative">
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
                <nav className="flex justify-center gap-12 mt-6 text-sm text-gray-500">
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

            {/* Popular Auctions Section */}
            <section className="w-full max-w-6xl mx-auto px-4">
                <h2 className="text-4xl font-bold text-center text-gray-800 mb-8">
                    Popular Auctions
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {auctions.slice(0, 4).map((auction) => (
                        <Link
                            key={auction.id}
                            to={`/auction/${auction.id}`}
                            className="border rounded-lg shadow-lg p-6 bg-white hover:shadow-2xl hover:scale-105 transition"
                        >
                            <h3 className="text-2xl font-semibold mb-4 text-center">
                                {auction.item}
                            </h3>
                            <p className="text-gray-600 text-center">
                                Quantity: {auction.quantity}
                            </p>
                            {auction.image && (
                                <img
                                    src={auction.image}
                                    alt={auction.item}
                                    className="w-32 h-32 mx-auto mt-2"
                                />
                            )}
                        </Link>
                    ))}
                </div>
            </section>

            {/* Footer Section */}
            <footer className="text-center mt-10">
                <Link
                    to="/donate"
                    className="text-blue-500 text-sm hover:underline"
                >
                    Donate
                </Link>
            </footer>
        </div>
    );
};

export default Home;