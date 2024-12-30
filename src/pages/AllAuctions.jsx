import React, { useContext, useState, useEffect, useMemo } from "react";
import { Link} from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import { parseInput, convertToShorthand} from "../utils/numberUtils";

const AllAuctions = () => {
    const { auctions, updateAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);

    // Memoize processed auctions with shorthand values
    const processedAuctions = useMemo(() =>
            auctions.map((auction) => ({
                ...auction,
                shorthandMinBid: convertToShorthand(auction.minBidMeat) || "0", // Precompute shorthand
                formattedQuantity: auction.quantity?.toLocaleString("en-US") || "0", // Format quantity with commas
            })),
        [auctions] // Only recompute if auctions change
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

        // Normalize and compare usernames for case insensitivity
        const auction = auctions.find((a) => a.id === auctionId);
        const auctionOwner = String(auction.owner).trim().toLowerCase();
        const currentUsername = String(currentUser.khubUsername).trim().toLowerCase();

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

    const handleCancelBid = (auctionId) => {
        setBids((prevBids) => ({
            ...prevBids,
            [auctionId]: { ...prevBids[auctionId], showInput: false, bidError: "" },
        }));
    };

    const handleBidConfirm = (auctionId) => {
        const { bidAmount } = bids[auctionId];
        const numericBid = parseInt(bidAmount.replace(/,/g, ""), 10);
        const auction = auctions.find((a) => a.id === auctionId);

        // Validate bid amount
        if (!numericBid || numericBid <= 0) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "This isn't a charity. Bid at least the minimum" },
            }));
            return;
        }

        if (numericBid > 20000000000) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "Bid cannot exceed 20 billion." },
            }));
            return;
        }

        // Check if user is already the highest bidder
        const lastBid = auction.bids?.[auction.bids.length - 1];
        if (lastBid?.bidder === currentUser.khubUsername) {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "You are already the highest bidder." },
            }));
            return;
        }

        //Check bid against current bid and minimum bid
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

            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { bidAmount: "", bidError: "", showInput: false },
            }));
        } else {
            setBids((prevBids) => ({
                ...prevBids,
                [auctionId]: { ...prevBids[auctionId], bidError: "Bid too low." },
            }));
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
        const isDeleting = rawValue.length < (bids[auctionId]?.bidAmount.replace(/,/g, "").length || 0);

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
        <div className="min-h-screen bg-[#DBE2EF] p-6">
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
                        key={auction.id}
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

                        {/* Use memoized shorthand value */}
                        <p className="text-xs text-[#3F72AF] mb-4">
                            Minimum Bid (Meat): {auction.shorthandMinBid}
                        </p>
                        {/* Other auction details */}

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
                                {auction.owner.trim().toLowerCase() === currentUser.khubUsername.trim().toLowerCase() ? (
                                    <Link
                                        to={`/auction/${auction.id}`}
                                        className="w-full bg-[#3F72AF] text-white font-bold py-2 px-4 rounded hover:bg-[#3F72AF] text-center block"
                                    >
                                        More Info
                                    </Link>
                                ) : (
                                    !bids[auction.id].showInput ? (
                                        <>
                                            <button
                                                onClick={() => handlePlaceBid(auction.id)}
                                                className="w-full bg-[#112D4E] text-white font-bold py-2 px-4 rounded hover:bg-[#3F72AF]"
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
                                    ) :
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
                                                className="w-1/2 bg-[#112D4E] text-white font-bold py-2 px-4 rounded hover:bg-[#3F72AF] mr-2"
                                            >
                                                Confirm
                                            </button>
                                            <button
                                                onClick={() => handleCancelBid(auction.id)}
                                                className="w-1/2 bg-red-500 text-white font-bold py-2 px-4 rounded hover:bg-red-700"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </>
                                )}
                                {bids[auction.id]?.bidError && (
                                    <p className="text-red-500 text-center text-sm mt-2">
                                        {bids[auction.id]?.bidError}
                                    </p>
                                )}
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
                ))}
            </div>
        </div>
    );
};

export default AllAuctions;