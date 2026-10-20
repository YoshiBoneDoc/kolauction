import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';

export default function SiteFooter({ className = '', showReportLink = true }) {
    return <footer className={`border-t bg-gray-100 px-4 py-3 text-center ${className}`}>
        <nav aria-label="Footer links" className="flex flex-wrap items-center justify-center gap-3 text-sm">
            <Link to="/donate" className="inline-flex min-h-11 items-center text-blue-700 hover:underline">Donate</Link>
            {showReportLink && <span aria-hidden="true">•</span>}
            {showReportLink && <Link to="/report-a-bug" className="inline-flex min-h-11 items-center text-blue-700 hover:underline">Report a Bug</Link>}
        </nav>
        <p className="text-xs text-gray-500">All game images are copyright Asymmetric Publications from The Kingdom of Loathing</p>
    </footer>;
}

SiteFooter.propTypes = { className: PropTypes.string, showReportLink: PropTypes.bool };
