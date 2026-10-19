import { useContext, useState, useEffect, useMemo } from "react";
import { Link} from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { parseInput, convertToShorthand} from "../utils/numberUtils";
import { getAuctionResult } from "../lib/auctionLifecycle";

const AllAuctions = () => {
    const { auctions, placeBid, isLoading, error } = useContext(AuctionsContext);
    const { currentUser, logoutUser } = useContext(UserContext); // Added logoutUser



    // Memoize processed auctions with shorthand values
    const processedAuctions = useMemo(() =>
            auctions
                .slice()
                .sort((a, b) => b.createdAt - a.createdAt) // Sort by descending ID
                .map((auction) => ({
                    ...auction,
                    shorthandMinBid: convertToShorthand(auction.minBidMeat) || "0",
                    formattedQuantity: auction.quantity?.toLocaleString("en-US") || "0",
                }))
        , [auctions]);

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

    const [countdowns, setCountdowns] = useState({});

    const [bids, setBids] = useState(() =>
        auctions.reduce((acc, auction) => {
            acc[auction.id] = { bidAmount: "", bidError: "", showInput: false };
            return acc;
        }, {})
    );

    const handlePlaceBid = (auctionId) => {

        if (!currentUser) {
            setBids((previous) => ({ ...previous, [auctionId]: {
                ...previous[auctionId], bidError: "Please log in to place a bid.",
            } }));
            return;
        }
        const auction = auctions.find((a) => a.id === auctionId);
        if (auction.sellerId === currentUser.id) return;

        // Show input field for valid users
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], showInput: true, bidError: "" },
        }));
    };

    useEffect(() => {
        const tick = () => setCountdowns(Object.fromEntries(
            auctions.map((auction) => [auction.id, calculateRemainingTime(auction.endTime)])
        ));
        tick();
        const interval = setInterval(tick, 1000);

        return () => clearInterval(interval);
    }, [auctions]);

    const formatNumber = (number) => number.toLocaleString("en-US");

    const handleCancelBid = (auctionId) => {
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], showInput: false, bidError: "" },
        }));
    };

    const handleBidConfirm = async (auctionId) => {
        if (bids[auctionId]?.isSubmitting) return;
        const numericBid = Number((bids[auctionId]?.bidAmount || "").replace(/,/g, ""));
        const setBidState = (values) => setBids((previous) => ({
            ...previous, [auctionId]: { ...previous[auctionId], ...values },
        }));
        if (!Number.isSafeInteger(numericBid) || numericBid < 1 || numericBid > 20000000000) {
            setBidState({ bidError: "Enter a whole-number bid between 1 and 20 billion Meat." });
            return;
        }
        if (!window.confirm(`Submit a bid of ${numericBid.toLocaleString("en-US")} Meat?`)) return;
        setBidState({ isSubmitting: true, bidError: "" });
        try {
            await placeBid(auctionId, numericBid);
            setBidState({ bidAmount: "", showInput: false });
        } catch (error) {
            setBidState({ bidError: error.message });
        } finally {
            setBidState({ isSubmitting: false });
        }
    };

    const handleInputChange = (auctionId, value) => {
        const inputElement = document.activeElement; // Get the input element
        if (!inputElement) return;

        const rawValue = value.replace(/,/g, ""); // Remove commas for processing
        const numericValue = parseInt(rawValue, 10); // Parse the raw value as a number
        const cursorPosition = inputElement.selectionStart; // Get the cursor position in the formatted value

        // If the numeric value exceeds 20 billion, stop processing and retain the old value
        const maxAmount = 20000000000;
        if (numericValue > maxAmount) {
            return;
        }

        // Count numeric digits up to the cursor position (ignoring commas)
        let digitsBeforeCursor = 0;
        for (let i = 0; i < cursorPosition; i++) {
            if (/\d/.test(value[i])) {
                digitsBeforeCursor++;
            }
        }

        // Detect deletion: input length is shorter than the current state
        const isDeleting = rawValue.length < ((bids[auctionId]?.bidAmount || "").replace(/,/g, "").length || 0);

        // If deleting, bypass formatting and update state directly
        if (isDeleting) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: {
                    ...prevBids[auctionId],
                    bidAmount: value, // Use raw value directly
                },
            }));
            return; // Exit early for deletion handling
        }

        // Process the raw value through parseInput while maintaining digit count
        const parsedValue = parseInput(rawValue); // Converts to sanitized value
        const sanitizedValue = parsedValue.replace(/,/g, ""); // Remove commas for further processing

        // Check if the number is capped at 20 billion
        const isCapped = sanitizedValue.length !== rawValue.length;

        // Calculate the new cursor position based on digits before the cursor
        let newCursorPosition = 0;
        let digitCount = 0;

        for (let i = 0; i < parsedValue.length; i++) {
            if (/\d/.test(parsedValue[i])) {
                digitCount++;
            }

            if (digitCount === digitsBeforeCursor) {
                newCursorPosition = i + 1; // Place cursor after the matching digit
                break;
            }
        }

        // Update the state with the sanitized value
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: {
                ...prevBids[auctionId],
                bidAmount: parsedValue,
            },
        }));

        // Restore the cursor position after formatting
        requestAnimationFrame(() => {
            // If the input is capped, place the cursor at the end
            if (isCapped) {
                inputElement.setSelectionRange(parsedValue.length, parsedValue.length);
            } else {
                inputElement.setSelectionRange(newCursorPosition, newCursorPosition);
            }
        });
    };

    return (
        <div className="min-h-screen bg-[#F9F9F9] p-6">
            {/* User Section at the Top Right */}
            <div className="absolute top-6 right-6 flex flex-col items-end text-right">
                {currentUser ? (
                    <div className="flex flex-col items-end gap-1 text-right">
            <span className="text-gray-700 text-sm font-bold">
                Welcome,{" "}
                <Link
                    to="/profile"
                    className="text-[#FE5F55] hover:underline"
                >
                    {currentUser.khubUsername || "User"} {/* Fallback for username */}
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
                    <Link to="/login" className="text-[#FE5F55] hover:underline text-sm">
                        Log In
                    </Link>
                )}
            </div>

            {/* Navigation and Title */}
            <div className="mb-4">
                <Link
                    to="/"
                    className="text-[#FE5F55] hover:text-[#FF9874] text-sm"
                >
                    Home
                </Link>
            </div>

            <h1 className="text-4xl font-bold text-center text-[#7695FF] mb-8">All Auctions</h1>
            {isLoading && <p role="status">Loading auctions…</p>}
            {!isLoading && !error && auctions.length === 0 && <p>No auctions have been listed yet.</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {processedAuctions.map((auction) => {
                    const result = getAuctionResult(auction);
                    return (
                    <div
                        key={auction.id}
                        className="border rounded-lg shadow-lg p-4 bg-[#F9F7F7] flex flex-col items-center"
                        style={{ backgroundColor: "#F8F6F4" }} // Tile background color set to #EBF6FF
                    >
                        {auction.image && (
                            <img
                                src={auction.image}
                                alt={auction.item}
                                className="w-32 h-32 object-contain mb-4"
                            />
                        )}

                        <h2 className="text-xl font-bold text-center mb-1">
                            <span className="text-[#14248A]">{auction.item}</span>
                            <span className="text-[#94A0F0]"> x{auction.formattedQuantity}</span>
                        </h2>

                        {/* Use memoized shorthand value */}
                        <p className="text-xs text-[#3F72AF] mb-4">
                            Minimum Bid (Meat): {auction.shorthandMinBid}
                        </p>
                        {/* Other auction details */}

                        <div className="text-center mb-4">
                            <p className="text-sm text-[#94A0F0] underline">Current Bid</p>
                            <p className="text-2xl font-extrabold text-[#112D4E]">
                                {auction.currentBid ? `${formatNumber(auction.currentBid)} Meat` : "No bids yet"}
                            </p>
                        </div>

                        {result.status === "active" && <p
                            className={`text-xs text-center ${
                                countdowns[auction.id]?.isRed ? "text-red-500" : "text-gray-500"
                            }`}
                        >
                            {countdowns[auction.id]?.timeString || "…"}
                        </p>}

                        {result.status === "active" ? (
                            <div className="mt-4 w-full">
                                {/* Added null check for currentUser */}
                                {currentUser?.id === auction.sellerId ? (
                                    <Link
                                        to={`/auction/${auction.id}`}
                                        className="w-full bg-[#3F72AF] text-white font-bold py-2 px-4 rounded hover:bg-[#3F72AF] text-center block"
                                    >
                                        More Info
                                    </Link>
                                ) : (
                                    !bids[auction.id]?.showInput ? (
                                        <>
                                            <button
                                                onClick={() => handlePlaceBid(auction.id)}
                                                className="w-full bg-[#3D52D5] text-white font-bold py-2 px-4 rounded hover:bg-[#7494EA]"
                                            >
                                                Place Bid
                                            </button>
                                            <Link
                                                to={`/auction/${auction.id}`}
                                                className="text-[#112D4E] underline hover:text-[#3F72AF] text-sm mt-2 block text-center"
                                            >
                                                More Info
                                            </Link>
                                        </>
                                    ) : (
                                        // Input logic for bidding
                                        <>
                                            <input
                                                type="text"
                                                value={bids[auction.id]?.bidAmount || ""}
                                                onChange={(e) => handleInputChange(auction.id, e.target.value)}
                                                placeholder="Enter bid (e.g., 10k, 1m)"
                                                className="w-full p-2 border border-gray-300 rounded placeholder-gray-500"
                                            />
                                            <div className="flex justify-between mt-2">
                                                <button
                                                    onClick={() => handleBidConfirm(auction.id)}
                                                    disabled={bids[auction.id]?.isSubmitting}
                                                    className="w-1/2 bg-[#3D52D5] text-white font-bold py-2 px-4 rounded hover:bg-[#7494EA] mr-2"
                                                >
                                                    {bids[auction.id]?.isSubmitting ? "Submitting…" : "Confirm"}
                                                </button>
                                                <button
                                                    onClick={() => handleCancelBid(auction.id)}
                                                    className="w-1/2 bg-[#F16055] text-white font-bold py-2 px-4 rounded hover:bg-[#FD8A8A]"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </>
                                    )
                                )}
                                {bids[auction.id]?.bidError && (
                                    <p className="text-red-500 text-center text-sm mt-2">
                                        {bids[auction.id]?.bidError}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className="text-center text-sm mt-4">
                                <p className="font-semibold">{result.label}</p>
                                {result.winnerId && (
                                    <p>Winner: {result.winner} · {formatNumber(result.finalPrice)} Meat</p>
                                )}
                                <Link to={`/auction/${auction.id}`} className="text-blue-700 underline mt-2 block">View outcome and history</Link>
                            </div>
                        )}
                    </div>
                    );
                })}
            </div>
        </div>
    );
};

export default AllAuctions;