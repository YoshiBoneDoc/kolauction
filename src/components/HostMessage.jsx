import PropTypes from 'prop-types';

export default function HostMessage({ message }) {
    if (!message?.trim()) return null;
    return <aside aria-label="Host message" className="listing-host-message flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-purple-900 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-100">
        <span className="shrink-0 font-semibold">Host Message</span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words italic [overflow-wrap:anywhere]">{message}</p>
    </aside>;
}

HostMessage.propTypes = { message: PropTypes.string };
