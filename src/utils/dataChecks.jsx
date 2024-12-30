/**
 * Validates a bid amount for an auction.
 *
 * @param {number} numericBid - The bid amount to validate.
 * @param {object} auction - The auction object containing currentBid, minBidMeat, and bids.
 * @param {string} currentUser - The username of the bidder.
 * @param {number} maxAmount - The maximum allowed bid (default: 20 billion).
 * @returns {object} - An object containing:
 *   - isValid (boolean): Whether the bid is valid.
 *   - error (string): Error message if the bid is invalid.
 *   - updatedAuction (object|null): Updated auction if the bid is valid.
 */
export const validateBid = ({ numericBid, auction, currentUser, maxAmount = 20000000000 }) => {
    if (!auction) {
        return { isValid: false, error: "Auction not found.", updatedAuction: null };
    }

    if (!currentUser) {
        return { isValid: false, error: "Only registered users may bid.", updatedAuction: null };
    }

    if (!numericBid || numericBid <= 0) {
        return { isValid: false, error: "This isn't a charity. Bid at least the minimum.", updatedAuction: null };
    }

    if (numericBid > maxAmount) {
        return { isValid: false, error: "Bid cannot exceed 20 billion.", updatedAuction: null };
    }

    // Check if user is already the highest bidder
    const lastBid = auction.bids?.[auction.bids.length - 1];
    if (lastBid?.bidder === currentUser) {
        return { isValid: false, error: "You are already the highest bidder.", updatedAuction: null };
    }

    // Check bid against current bid and minimum bid
    if (numericBid <= (auction.currentBid || 0)) {
        return { isValid: false, error: "Your bid must be higher than the current bid.", updatedAuction: null };
    }

    if (numericBid < auction.minBidMeat) {
        return { isValid: false, error: "Your bid must meet the minimum bid requirement.", updatedAuction: null };
    }

    // Create updated auction object if valid
    const updatedAuction = {
        ...auction,
        currentBid: numericBid,
        bids: [
            ...(auction.bids || []),
            { bidder: currentUser, amount: numericBid, timestamp: Date.now() },
        ],
    };

    return { isValid: true, error: "", updatedAuction };
};

/**
 * Validates numeric input with configurable caps.
 * @param {number} numericValue - The numeric value to validate.
 * @param {number} maxAmount - The maximum allowable value.
 * @param {string} type - The type of validation (e.g., "quantity" or "minimum bid").
 * @returns {object} - Validation result with isValid and error.
 */
export const validateInput = (numericValue, maxAmount, type) => {
    if (isNaN(numericValue) || numericValue <= 0) {
        return { isValid: false, error: `${type} must be a positive number.` };
    }

    if (numericValue > maxAmount) {
        return { isValid: false, error: `${type} cannot exceed ${maxAmount.toLocaleString("en-US")}.` };
    }

    return { isValid: true, error: "" };
};

/**
 * Validates auction submission inputs.
 * @param {object} inputs - The inputs to validate.
 * @param {number} inputs.quantity - The auction quantity.
 * @param {number} inputs.minBidMeat - The minimum bid for the auction.
 * @param {string} inputs.selectedItem - The selected item for the auction.
 * @returns {object} - Validation result with isValid and error.
 */
export const validateAuctionSubmission = ({ quantity, minBidMeat, selectedItem }) => {
    if (!selectedItem) {
        return { isValid: false, error: "Please select an item to auction." };
    }
    if (!quantity || quantity <= 0) {
        return { isValid: false, error: "Quantity must be a positive number." };
    }
    if (quantity > 5000000000) {
        return { isValid: false, error: "Quantity cannot exceed 5 billion." };
    }
    if (!minBidMeat || minBidMeat <= 0) {
        return { isValid: false, error: "Minimum bid must be a positive number." };
    }
    if (minBidMeat > 10000000000) {
        return { isValid: false, error: "Minimum bid cannot exceed 10 billion." };
    }
    return { isValid: true, error: "" };
};