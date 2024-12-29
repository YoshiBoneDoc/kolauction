import {parseInput} from "./numberUtils.jsx";

// Checks if the current user is already the highest bidder
export const isHighestBidder = (auction, currentUser) => {
    if (!auction?.bids?.length || !currentUser) return false;
    return auction.bids[auction.bids.length - 1]?.bidder === currentUser?.khubUsername;
};

// Validates if a bid meets the auction requirements
export const isValidBid = (auction, bidAmount) => {
    if (!auction || bidAmount <= 0) return false;
    return bidAmount > (auction.currentBid || 0) && bidAmount >= auction.minBidMeat;
};

// Cap minimum bid at 10 billion (10b)
export const capMinBid = (value) => {
    // Allow only numbers and shorthand characters 'k', 'm', 'b'
    const sanitizedValue = value.replace(/[^0-9kmbKMB]/g, "");

    // Parse the shorthand into a numeric value to check the cap
    const numericValue = parseInput(sanitizedValue);

    // Cap the value at 10 billion (10b)
    if (!isNaN(numericValue) && numericValue > 10000000000) {
        return "10b"; // Return the max allowed shorthand for minimum bid
    }

    return sanitizedValue; // Return sanitized value
};

// Centralized error messages for common scenarios
export const getBidErrorMessage = (auction, bidAmount, currentUser, minBid) => {
    if (!auction) return "Auction not found.";
    if (!currentUser) return "Only registered users may bid.";
    if (isHighestBidder(auction, currentUser)) return "You are already the highest bidder.";
    if (!isValidBid(auction, bidAmount)) return "Bid is too low.";
    if (parseInput(bidAmount) > 20000000000) return "Cannot exceed 20 billion.";
    if (parseInput(minBid) > 10000000000) return "Minimum bid cannot exceed 10 billion.";
    return ""; // No error
};