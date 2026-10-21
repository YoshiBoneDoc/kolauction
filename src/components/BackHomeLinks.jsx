import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import BackButton from './BackButton';

export default function BackHomeLinks({ className = '' }) {
    return <nav aria-label="Page navigation" className={`flex flex-wrap items-center gap-4 text-sm ${className}`}>
        <BackButton />
        <Link to="/" className="inline-flex min-h-9 items-center text-blue-500 hover:underline">Home</Link>
    </nav>;
}
BackHomeLinks.propTypes = { className: PropTypes.string };
