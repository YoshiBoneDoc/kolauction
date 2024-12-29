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