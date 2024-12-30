import React, { useState, useContext } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuctionsContext } from "../context/AuctionsContext";
import { UserContext } from "../context/UserContext";
import items from "../data/items.json";
import { getBidErrorMessage} from "../utils/dataChecks";
import { parseInput, convertToShorthand } from "../utils/numberUtils";


const AuctionAnItem = () => {
    const { addAuction } = useContext(AuctionsContext);
    const { currentUser } = useContext(UserContext);
    const navigate = useNavigate();

    const [selectedItem, setSelectedItem] = useState("");
    const [quantity, setQuantity] = useState("1");
    const [minBidMeat, setMinBidMeat] = useState("");
    const [auctionTime, setAuctionTime] = useState("24");
    const [showPreview, setShowPreview] = useState(false);
    const [previewImage, setPreviewImage] = useState("");
    const [errorMessage, setErrorMessage] = useState("");

    const handleQuantityChange = (e) => {
        const input = e.target;
        const rawValue = input.value.replace(/,/g, ""); // Remove commas for processing
        const cursorPosition = input.selectionStart; // Get the cursor position
        const maxCheck = parseInt(rawValue, 10); // Parse the raw value as a number


        // If the numeric value exceeds 5 billion, stop processing and retain the old value
        const maxAmount = 20000000000;
        if (maxCheck > maxAmount) {
            return;
        }

        // Count numeric digits up to the cursor position (ignoring commas)
        let digitsBeforeCursor = 0;
        for (let i = 0; i < cursorPosition; i++) {
            if (/\d/.test(input.value[i])) {
                digitsBeforeCursor++;
            }
        }

        // Detect deletion: input length is shorter than the current state
        const isDeleting = rawValue.length < (quantity.replace(/,/g, "").length || 0);

        if (isDeleting) {
            // Update state directly with raw value for deletion
            setQuantity(input.value); // Use raw value directly
            return; // Exit early for deletion handling
        }

        // Process the raw value through parseInput
        let parsedValue = parseInput(rawValue); // Converts to sanitized value
        const numericValue = parseInt(parsedValue.replace(/,/g, ""), 10);

        // Calculate the new cursor position
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
        setQuantity(parsedValue);

        // Restore the cursor position after formatting
        requestAnimationFrame(() => {
            if (numericValue > 5_000_000_000) {
                // If capped, place the cursor at the end
                input.setSelectionRange(parsedValue.length, parsedValue.length);
            } else {
                // Otherwise, set it based on the calculated position
                input.setSelectionRange(newCursorPosition, newCursorPosition);
            }
        });
    };

    const handleMinBidMeatChange = (e) => {
        const input = e.target;
        const rawValue = input.value.replace(/,/g, ""); // Remove commas for processing
        const cursorPosition = input.selectionStart; // Get the cursor position
        const maxCheck = parseInt(rawValue, 10); // Parse the raw value as a number

        // If the numeric value exceeds 5 billion, stop processing and retain the old value
        const maxAmount = 10000000000;
        if (maxCheck > maxAmount) {
            return;
        }

        // Count numeric digits up to the cursor position (ignoring commas)
        let digitsBeforeCursor = 0;
        for (let i = 0; i < cursorPosition; i++) {
            if (/\d/.test(input.value[i])) {
                digitsBeforeCursor++;
            }
        }

        // Detect deletion: input length is shorter than the current state
        const isDeleting = rawValue.length < (minBidMeat.replace(/,/g, "").length || 0);

        if (isDeleting) {
            // Update state directly with raw value for deletion
            setMinBidMeat(input.value); // Use raw value directly
            return; // Exit early for deletion handling
        }

        // Process the raw value through parseInput
        let parsedValue = parseInput(rawValue); // Converts to sanitized value
        const numericValue = parseInt(parsedValue.replace(/,/g, ""), 10);


        // Calculate the new cursor position
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
        setMinBidMeat(parsedValue);

        // Restore the cursor position after formatting
        requestAnimationFrame(() => {
            if (numericValue > 10_000_000_000) {
                // If capped, place the cursor at the end
                input.setSelectionRange(parsedValue.length, parsedValue.length);
            } else {
                // Otherwise, set it based on the calculated position
                input.setSelectionRange(newCursorPosition, newCursorPosition);
            }
        });
    };

    const handleFormSubmit = (e) => {
        e.preventDefault();

        // Parse and sanitize the minimum bid input
        const parsedMinBidMeat = parseInt(minBidMeat.replace(/,/g, ""), 10);
        if (isNaN(parsedMinBidMeat) || parsedMinBidMeat <= 0) {
            setErrorMessage("Minimum bid must be a positive number.");
            return;
        }
        if (parsedMinBidMeat > 10000000000) {
            setErrorMessage("Minimum bid cannot exceed 10 billion.");
            return;
        }

        // Parse and sanitize the quantity input
        const parsedQuantity = parseInt(quantity.replace(/,/g, ""), 10);
        if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
            setErrorMessage("Quantity must be a positive number.");
            return;
        }
        if (parsedQuantity > 5000000000) {
            setErrorMessage("Quantity cannot exceed 5 billion.");
            return;
        }

        // Validate selected item
        if (!selectedItem) {
            setErrorMessage("Please select an item to auction.");
            return;
        }

        // All validation passed: Proceed with auction preview
        const matchedItem = items.find((item) => item.name === selectedItem);
        const gifName = matchedItem?.image?.split("/").pop();
        const imageUrl = gifName
            ? `http://images.kingdomofloathing.com/itemimages/${gifName}`
            : "https://via.placeholder.com/150";

        setPreviewImage(imageUrl);
        setShowPreview(true);
        setErrorMessage(""); // Clear errors on valid input
    };

    const handleConfirmAuction = () => {
        // Parse and sanitize the minimum bid input
        const parsedMinBidMeat = parseInt(minBidMeat.replace(/,/g, ""), 10);
        if (isNaN(parsedMinBidMeat) || parsedMinBidMeat <= 0) {
            alert("Minimum bid must be a positive number.");
            return;
        }
        if (parsedMinBidMeat > 10000000000) {
            alert("Minimum bid cannot exceed 10 billion.");
            return;
        }

        // Parse and sanitize the quantity input
        const parsedQuantity = parseInt(quantity.replace(/,/g, ""), 10);
        if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
            alert("Quantity must be a positive number.");
            return;
        }
        if (parsedQuantity > 5000000000) {
            alert("Quantity cannot exceed 5 billion.");
            return;
        }

        // Prepare auction object
        const endTime = Date.now() + auctionTime * 60 * 60 * 1000;

        const newAuction = {
            id: Date.now(),
            item: selectedItem,
            quantity: parsedQuantity,
            minBidMeat: parsedMinBidMeat,
            auctionTime,
            endTime,
            currentBid: 0,
            owner: currentUser.khubUsername,
            image: previewImage,
            bids: [],
        };

        // Add auction and navigate back
        addAuction(newAuction);
        setShowPreview(false);
        alert("Auction submitted!");
        navigate("/auctions");
    };

    // Redirect for unauthenticated users
    if (!currentUser) {
        return (
            <div className="min-h-screen bg-gray-50 flex flex-col">
                <div className="absolute top-4 left-4">
                    <Link
                        to="/"
                        className="text-blue-500 underline hover:text-blue-700 text-sm"
                    >
                        Home
                    </Link>
                </div>
                <div className="flex-grow flex flex-col justify-center items-center">
                    <h1 className="text-2xl font-bold text-center text-red-600 mb-4">
                        You must be logged in to auction an item.
                    </h1>
                    <div className="text-center">
                        <Link
                            to="/login"
                            className="text-blue-500 underline hover:text-blue-700 text-lg"
                        >
                            Log In
                        </Link>
                        <p className="mt-4 text-sm text-gray-600">
                            Don’t have an account?{" "}
                            <Link
                                to="/register"
                                className="text-blue-500 underline hover:text-blue-700"
                            >
                                Register
                            </Link>
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mb-4">
                <Link
                    to="/"
                    className="text-blue-500 underline hover:text-blue-700 text-sm"
                >
                    Home
                </Link>
            </div>

            <h1 className="text-4xl font-bold text-center text-blue-600 mb-8">Auction an Item</h1>
            <form onSubmit={handleFormSubmit} className="max-w-lg mx-auto bg-white shadow-md rounded px-8 pt-6 pb-8">
                {errorMessage && (
                    <p className="text-red-500 text-center mb-4 font-bold">{errorMessage}</p>
                )}
                <label htmlFor="item" className="block text-gray-700 text-sm font-bold mb-2">
                    Select an Item:
                </label>
                <select
                    id="item"
                    value={selectedItem}
                    onChange={(e) => setSelectedItem(e.target.value)}
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                >
                    <option value="" disabled>
                        Select an item
                    </option>
                    {items.map((item) => (
                        <option key={item.name} value={item.name}>
                            {item.name}
                        </option>
                    ))}
                </select>

                <label htmlFor="quantity" className="block text-gray-700 text-sm font-bold mb-2">
                    Quantity:
                </label>
                <input
                    id="quantity"
                    type="text" // Changed to text to allow shorthand input
                    value={quantity}
                    onChange={handleQuantityChange}
                    placeholder="Enter quantity (e.g., 1k, 10m)"
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                />

                <label htmlFor="minBidMeat" className="block text-gray-700 text-sm font-bold mb-2">
                    Minimum Bid (Meat):
                </label>
                <input
                    id="minBidMeat"
                    type="text" // Changed to text to allow shorthand input
                    value={minBidMeat}
                    onChange={handleMinBidMeatChange}
                    placeholder="Enter minimum bid (e.g., 20000, 1k, 10m, 20b)"
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                />

                <label htmlFor="auctionTime" className="block text-gray-700 text-sm font-bold mb-2">
                    Auction Duration:
                </label>
                <select
                    id="auctionTime"
                    value={auctionTime}
                    onChange={(e) => setAuctionTime(e.target.value)}
                    className="block w-full p-2 border border-gray-300 rounded mb-4"
                >
                    <option value="6">6 Hours</option>
                    <option value="12">12 Hours</option>
                    <option value="24">1 Day</option>
                    <option value="72">3 Days</option>
                    <option value="168">7 Days</option>
                    <option value="720">1 Month</option>
                </select>

                <button
                    type="submit"
                    className="w-full bg-blue-500 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
                >
                    Preview Auction
                </button>
            </form>

            {showPreview && (
                <div className="max-w-lg mx-auto bg-gray-100 shadow-md rounded mt-6 p-6">
                    <h2 className="text-2xl font-bold text-center mb-4">Preview Auction</h2>
                    {selectedItem && (
                        <div className="flex flex-col items-center">
                            <img
                                src={previewImage}
                                alt={selectedItem}
                                className="w-32 h-32 object-contain mb-4"
                            />
                            <p>Item: {selectedItem}</p>
                            <p>Quantity: {quantity}</p>
                            <p>Min Bid: {convertToShorthand(parseInput(minBidMeat)) || "0"}</p>

                            <p>Duration: {auctionTime} hours</p>
                        </div>
                    )}
                    <div className="flex justify-center mt-4">
                        <button
                            onClick={handleConfirmAuction}
                            className="bg-green-500 text-white font-bold py-2 px-4 rounded hover:bg-green-700 mx-2"
                        >
                            Confirm Auction
                        </button>
                        <button
                            onClick={() => setShowPreview(false)}
                            className="bg-red-500 text-white font-bold py-2 px-4 rounded hover:bg-red-700 mx-2"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AuctionAnItem;