import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Temporary joke: intentionally resets on refresh.
export default function UpsideDownToggle() {
    const [upsideDown, setUpsideDown] = useState(false);
    useEffect(() => {
        document.documentElement.classList.toggle('upside-down', upsideDown);
        return () => document.documentElement.classList.remove('upside-down');
    }, [upsideDown]);

    const button = <button type="button" aria-pressed={upsideDown}
        onClick={() => setUpsideDown(current => !current)}
        className="min-h-11 max-w-full bg-transparent px-2 text-xs text-gray-600">
        {upsideDown ? "I've reconsidered" : 'I can only read upside down'}
    </button>;
    return upsideDown ? createPortal(
        <div className="fixed right-4 top-4 z-[100] rounded-md border border-gray-200 bg-white shadow-sm">
            {button}
        </div>,
        document.body,
    ) : button;
}
