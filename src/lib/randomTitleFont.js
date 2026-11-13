export const titleText = 'KoL Auction Hub';
// Community suggestions and the hearted finalists supplied for the shortlist.
export const titleFontShortlist = Object.freeze([
    'Newsreader', 'Atkinson Hyperlegible', 'Cabin Sketch', 'Grenze Gotisch',
    'Handlee', 'Jersey 25 Charted', 'Jomolhari', 'Lexend Exa', 'Mynerve',
    'Romanesco', 'Sorts Mill Goudy', 'Stack Sans Text', 'Comic Sans MS',
]);
export async function fontCatalog() { return titleFontShortlist; }
export function activeFontPoll(feed) {
    return [feed?.font_poll, feed?.poll, ...(feed?.answered_polls || []), ...(feed?.repeatable_polls || []), ...(feed?.skipped_polls || [])]
        .find(poll => poll?.active === true && /\bfonts?\b/i.test(poll.question || ''));
}
export function fontPollActive(feed) { return Boolean(activeFontPoll(feed)); }
export function randomFamily(families, previous, random = Math.random) {
    const choices = families.filter(name => name !== previous);
    return choices.length ? choices[Math.floor(random() * choices.length)] : null;
}
export async function loadTitleFont(family) {
    // Comic Sans is a system font, rather than a Google Fonts family.
    if (family === 'Comic Sans MS') return null;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&text=${encodeURIComponent(titleText)}&display=swap`;
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Font timed out')), 10000);
            link.onload = () => { clearTimeout(timer); resolve(); };
            link.onerror = () => { clearTimeout(timer); reject(new Error('Font unavailable')); };
            document.head.append(link);
        });
        const loaded = await Promise.race([
            document.fonts.load(`400 48px ${JSON.stringify(family)}`, titleText),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Font timed out')), 10000)),
        ]);
        if (!loaded.length) throw new Error('Font unavailable');
        return link;
    } catch (error) { link.remove(); throw error; }
}
