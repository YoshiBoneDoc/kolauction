import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

export default function CopyMessage({ text, label = 'message', className = '', compact = false, inline = false, inputId, recipient }) {
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
            <div className={`copy-message-field flex min-w-0 items-center rounded bg-gray-100 ${inline && recipient ? 'gap-1' : 'gap-2'} ${inline ? 'h-6 rounded-none rounded-l-[2px] border border-r-0 border-gray-300' : compact ? 'h-12 px-3' : 'p-3'}`}>
                {inline ? <input id={inputId} type="text" readOnly value={text} aria-label={label} title={text} onFocus={event => event.target.select()}
                    style={recipient ? { width: `calc(${text.length}ch + 0.5rem)`, maxWidth: '65%' } : undefined}
                    className={`h-full min-w-0 rounded-none border-0 bg-transparent text-left font-mono text-[13px] text-gray-700 focus:outline-none ${recipient ? 'shrink-0 px-1' : 'flex-1 px-2'}`} />
                    : <code className="min-w-0 flex-1 break-all text-left font-mono select-all">{text}</code>}
                {inline && recipient && <span title={`→ ${recipient}`} className="min-w-0 flex-1 truncate whitespace-nowrap font-sans text-[11px] text-gray-500">→ {recipient}</span>}
                <button type="button" onClick={copy} disabled={pending} aria-label={`Copy ${label}`}
                    title={status === 'copied' ? 'Copied!' : status === 'error' ? 'Could not copy. Select the message and copy it manually.' : `Copy ${label}`}
                    className={`inline-flex shrink-0 items-center justify-center rounded text-blue-700 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50 ${inline ? 'h-full w-7 rounded-none border-0 bg-gray-100 p-0' : compact ? 'h-8 w-8 border-0 bg-white p-1' : 'min-h-11 min-w-11'}`}>
                    <svg aria-hidden="true" width={inline ? 14 : compact ? 18 : 20} height={inline ? 14 : compact ? 18 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        {status === 'copied' ? <path d="m5 12 4 4L19 6" /> : <>
                            <rect x="8" y="4" width="8" height="4" rx="1" />
                            <path d="M8 6H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2" />
                        </>}
                    </svg>
                </button>
            </div>
            <p role="status" aria-live="polite" className={status === 'error' && !inline ? 'mt-1 text-sm text-red-700' : 'sr-only'}>
                {status === 'copied' ? 'Copied!' : status === 'error' ? 'Could not copy. Select the message and copy it manually.' : ''}
            </p>
        </div>
    );
}

CopyMessage.propTypes = {
    text: PropTypes.string.isRequired,
    label: PropTypes.string,
    className: PropTypes.string,
    compact: PropTypes.bool,
    inline: PropTypes.bool,
    inputId: PropTypes.string,
    recipient: PropTypes.string,
};
