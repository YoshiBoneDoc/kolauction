import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

export default function CopyMessage({ text, label = 'message', className = '' }) {
    const [feedback, setFeedback] = useState(null);
    const [pending, setPending] = useState(false);
    const timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const status = feedback?.text === text ? feedback.status : '';

    async function copy() {
        clearTimeout(timer.current);
        setPending(true);
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(text);
            setFeedback({ text, status: 'copied' });
            timer.current = setTimeout(() => setFeedback(null), 2500);
        } catch {
            setFeedback({ text, status: 'error' });
        } finally {
            setPending(false);
        }
    }

    return (
        <div className={className}>
            <div className="flex min-w-0 items-center gap-2 rounded bg-gray-100 p-3">
                <code className="min-w-0 flex-1 break-all text-left font-mono select-all">{text}</code>
                <button type="button" onClick={copy} disabled={pending} aria-label={`Copy ${label}`}
                    title={status === 'copied' ? 'Copied!' : `Copy ${label}`}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-blue-700 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50">
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        {status === 'copied' ? <path d="m5 12 4 4L19 6" /> : <>
                            <rect x="8" y="4" width="8" height="4" rx="1" />
                            <path d="M8 6H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2" />
                        </>}
                    </svg>
                </button>
            </div>
            <p role="status" aria-live="polite" className={status === 'error' ? 'mt-1 text-sm text-red-700' : 'sr-only'}>
                {status === 'copied' ? 'Copied!' : status === 'error' ? 'Could not copy. Select the message and copy it manually.' : ''}
            </p>
        </div>
    );
}

CopyMessage.propTypes = {
    text: PropTypes.string.isRequired,
    label: PropTypes.string,
    className: PropTypes.string,
};
