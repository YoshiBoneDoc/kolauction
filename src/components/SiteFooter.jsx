import { NavLink } from 'react-router-dom';
import PropTypes from 'prop-types';

export default function SiteFooter({ className = '' }) {
    return <footer className={`site-footer border-t bg-gray-100 px-4 py-3 text-center ${className}`}>
        <nav aria-label="Footer links" className="flex flex-wrap items-center justify-center gap-3 text-sm">
            <NavLink to="/donate" end className="site-footer-link inline-flex min-h-11 items-center text-blue-700 hover:underline">Donate</NavLink>
            <span aria-hidden="true">•</span>
            <NavLink to="/report-a-bug" end className="site-footer-link inline-flex min-h-11 items-center text-blue-700 hover:underline">Report a Bug</NavLink>
            <span aria-hidden="true">•</span>
            <NavLink to="/meet-the-creator" end className="site-footer-link inline-flex min-h-11 items-center text-blue-700 hover:underline">Meet the Creator</NavLink>
        </nav>
        <p className="text-xs text-gray-500">All game images are copyright Asymmetric Publications from The Kingdom of Loathing</p>
    </footer>;
}

SiteFooter.propTypes = { className: PropTypes.string };
