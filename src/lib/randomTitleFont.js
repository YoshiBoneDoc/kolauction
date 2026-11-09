export const titleText = 'KoL Auction Hub';
let catalogPromise;
export function googleFontFamilies(rows) {
    return [...new Set(rows.filter(row => row.type === 'google' && row.subsets?.includes('latin') && row.styles?.includes('normal')).map(row => row.family))];
}
export function fontCatalog() {
    if (!catalogPromise) catalogPromise = fetch('https://api.fontsource.org/v1/fonts', { signal: AbortSignal.timeout(15000) })
        .then(response => { if (!response.ok) throw new Error('Catalog unavailable'); return response.json(); })
        .then(googleFontFamilies).catch(error => { catalogPromise = undefined; throw error; });
    return catalogPromise;
}
export function fontPollActive(feed) {
    return [feed?.poll, ...(feed?.answered_polls || []), ...(feed?.repeatable_polls || []), ...(feed?.skipped_polls || [])]
        .some(poll => poll?.active === true && /\bfonts?\b/i.test(poll.question || ''));
}
export function randomFamily(families, previous, random = Math.random) {
    const choices = families.filter(name => name !== previous);
    return choices.length ? choices[Math.floor(random() * choices.length)] : null;
}
export async function loadTitleFont(family) {
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
