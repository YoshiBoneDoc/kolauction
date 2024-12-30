export const parseInput = (value) => {
    // Ensure input is always a string
    if (typeof value !== "string") value = String(value);

    // Return an empty string if the input is empty
    if (!value) return "";

    // Remove any commas or invalid characters (allow numbers and shorthand 'k', 'm', 'b')
    value = value.replace(/[^0-9kmbKMB]/g, "");

    // Remove any decimals if present
    value = value.replace(/\./g, "");

    // Remove invalid characters (allow only numbers, '.', 'k', 'm', 'b')
    value = value.replace(/[^0-9.kmbKMB]/g, "");

    // Allow only one shorthand letter ('k', 'm', 'b') by matching the first occurrence
    const letterMatches = value.match(/[kmbKMB]/g);
    if (letterMatches && letterMatches.length > 1) {
        // If more than one shorthand letter exists, invalidate input
        return "";
    }

    // Ensure there is at most one decimal point
    const decimalMatches = value.match(/\./g);
    if (decimalMatches && decimalMatches.length > 1) {
        // If more than one decimal exists, remove all but the first one
        const firstDecimalIndex = value.indexOf(".");
        value = value.slice(0, firstDecimalIndex + 1) + value.slice(firstDecimalIndex + 1).replace(/\./g, "");
    }

    // Check for valid input using a strict regex
    const shorthandRegex = /^(\d+(\.\d+)?)([kKmMbB]?)$/;
    const match = value.match(shorthandRegex);

    if (!match) {
        // Return empty string if input does not match the valid pattern
        return "";
    }

    // Extract parts from the matched input
    const numericPart = parseFloat(match[1]); // The numeric part
    const unit = match[3]?.toLowerCase(); // The shorthand unit (if present)

    // Convert shorthand letters into their multiplier values
    let numericValue;
    switch (unit) {
        case "k":
            numericValue = numericPart * 1_000; // Convert to thousands
            break;
        case "m":
            numericValue = numericPart * 1_000_000; // Convert to millions
            break;
        case "b":
            numericValue = numericPart * 1_000_000_000; // Convert to billions
            break;
        default:
            numericValue = numericPart; // No shorthand, direct numeric value
            break;
    }

    // Cap the resulting number at 20 billion
    if (numericValue > 20_000_000_000) {
        numericValue = 20_000_000_000;
    }

    // Format the numeric value with commas for dynamic readability
    return numericValue.toLocaleString("en-US");
};

export const convertToShorthand = (value) => {
    // Remove commas from the input to allow parsing
    const sanitizedValue = value.toString().replace(/,/g, "").trim();
    // Parse the numeric value, allowing decimals
    const numericValue = parseFloat(sanitizedValue);

    if (isNaN(numericValue)) {
        console.log("Invalid value for shorthand conversion:", value);
        return ""; // Return an empty string for invalid values
    }

    console.log("Converting value:", numericValue);

    if (numericValue >= 1_000_000_000) {
        return `${(numericValue / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}b`;
    }
    if (numericValue >= 1_000_000) {
        return `${(numericValue / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
    }
    if (numericValue >= 1_000) {
        return `${(numericValue / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    }

    return numericValue.toString(); // Return the number as-is if no shorthand is needed
};

/**
 * Processes input for numeric fields with optional suffixes (k, m, b).
 *
 * @param {string} inputValue - The raw user input.
 * @param {HTMLElement} inputElement - The input DOM element.
 * @param {number} maxAmount - The maximum allowed value (default: 20 billion).
 * @returns {object} - Processed result with:
 *   - formattedValue (string): The formatted value with commas.
 *   - numericValue (number): The numeric equivalent.
 *   - newCursorPosition (number): Suggested cursor position.
 *   - isValid (boolean): Whether the input is valid.
 *   - error (string): Error message if invalid.
 */
export const processBidInput = (inputValue, inputElement, maxAmount = 20000000000) => {
    if (!inputElement) return { isValid: false, error: "Input element not found." };

    // Normalize input and remove commas
    let value = inputValue.toLowerCase();
    console.log("Raw Input Value:", value);

    const rawValue = value.replace(/,/g, "");
    const cursorPosition = inputElement.selectionStart;

    // Handle empty input
    if (rawValue === "") {
        return { formattedValue: "", numericValue: 0, newCursorPosition: 0, isValid: true, error: "" };
    }

    // Cap the value at the maximum allowed amount
    if (parseInt(rawValue, 10) > maxAmount) {
        return { isValid: false, error: `Value cannot exceed ${maxAmount.toLocaleString("en-US")}.` };
    }

    let numericValue;

    // Match valid input with optional suffix
    const match = rawValue.match(/^(\d+)([kmb]?)$/);
    console.log("Match Result:", match);

    if (match) {
        const numberPart = parseInt(match[1], 10); // Numeric portion
        const suffix = match[2]; // Suffix portion (if any)
        console.log("Number Part:", numberPart, "Suffix:", suffix);

        // Convert based on suffix
        switch (suffix) {
            case "k":
                numericValue = numberPart * 1000;
                break;
            case "m":
                numericValue = numberPart * 1000000;
                break;
            case "b":
                numericValue = numberPart * 1000000000;
                break;
            default:
                numericValue = numberPart; // No suffix
        }
        console.log("Converted Numeric Value:", numericValue);

        // Cap the value at the maximum allowed amount
        if (numericValue > maxAmount) {
            numericValue = maxAmount;
        }
    } else {
        // If invalid input
        console.error("Invalid Input Detected");
        return { isValid: false, error: "Invalid input. Use digits optionally followed by k, m, or b." };
    }

    // Format the numeric value with commas
    const formattedValue = numericValue.toLocaleString("en-US");
    console.log("Formatted Value:", formattedValue);

    // Count numeric digits up to the cursor position (ignoring commas)
    let digitsBeforeCursor = 0;
    for (let i = 0; i < cursorPosition; i++) {
        if (/\d/.test(value[i])) {
            digitsBeforeCursor++;
        }
    }
    console.log("Digits Before Cursor:", digitsBeforeCursor);

    // Calculate the new cursor position
    let newCursorPosition = 0;
    let digitCount = 0;
    for (let i = 0; i < formattedValue.length; i++) {
        if (/\d/.test(formattedValue[i])) {
            digitCount++;
        }
        if (digitCount === digitsBeforeCursor) {
            newCursorPosition = i + 1;
            break;
        }
    }
    console.log("New Cursor Position:", newCursorPosition);

    return {
        formattedValue,
        numericValue,
        newCursorPosition,
        isValid: true,
        error: "",
    };
};