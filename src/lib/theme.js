export const THEME_STORAGE_KEY = 'khub-theme';

export function readThemePreference(environment = globalThis) {
    try {
        const value = environment.localStorage?.getItem(THEME_STORAGE_KEY);
        return value === 'light' || value === 'dark' ? value : null;
    } catch { return null; }
}

export function resolveTheme(environment = globalThis) {
    const saved = readThemePreference(environment);
    if (saved) return saved;
    try { return environment.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { return 'light'; }
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
    if (!root) return;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
}

export function saveTheme(theme, environment = globalThis) {
    try { environment.localStorage?.setItem(THEME_STORAGE_KEY, theme); }
    catch { /* The current tab can still switch when browser storage is unavailable. */ }
}
