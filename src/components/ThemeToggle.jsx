import { useEffect, useRef, useState } from 'react';
import { applyTheme, readThemePreference, resolveTheme, saveTheme, THEME_STORAGE_KEY } from '../lib/theme';

export default function ThemeToggle() {
    const [theme, setTheme] = useState(() => globalThis.document?.documentElement.dataset.theme || resolveTheme());
    const manuallySelected = useRef(false);
    useEffect(() => {
        applyTheme(theme);
    }, [theme]);
    useEffect(() => {
        const system = window.matchMedia?.('(prefers-color-scheme: dark)');
        const syncStorage = event => {
            if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
            manuallySelected.current = false;
            setTheme(resolveTheme());
        };
        const syncSystem = () => {
            if (!manuallySelected.current && !readThemePreference()) setTheme(resolveTheme());
        };
        window.addEventListener('storage', syncStorage);
        system?.addEventListener('change', syncSystem);
        return () => {
            window.removeEventListener('storage', syncStorage);
            system?.removeEventListener('change', syncSystem);
        };
    }, []);
    const dark = theme === 'dark';
    return <button type="button" aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} aria-pressed={dark}
        title={`Switch to ${dark ? 'light' : 'dark'} mode`}
        onClick={() => {
            const next = dark ? 'light' : 'dark';
            manuallySelected.current = true;
            saveTheme(next);
            applyTheme(next);
            setTheme(next);
        }} className="theme-toggle inline-flex min-h-11 items-center gap-2 bg-transparent px-2 text-gray-600">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-5 w-5 shrink-0">
            {dark ? <><circle cx="12" cy="12" r="4" /><path strokeLinecap="round" d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>
                : <path strokeLinecap="round" strokeLinejoin="round" d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z" />}
        </svg>
        <span>{dark ? 'Light' : 'Dark'} mode</span>
    </button>;
}
