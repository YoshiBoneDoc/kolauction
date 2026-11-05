// Catalog names are text, never HTML. Decode quotation entities in one pass only.
export function decodeItemName(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/&(?:quot|apos|#0*34|#0*39|#x0*22|#x0*27);/gi, entity => /^(?:&quot;|&#0*34;|&#x0*22;)$/i.test(entity) ? '"' : "'");
}
