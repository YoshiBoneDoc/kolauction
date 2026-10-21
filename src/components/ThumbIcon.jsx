import PropTypes from 'prop-types';

export default function ThumbIcon({ down = false, className = '' }) {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className={`${className} ${down ? 'rotate-180' : ''}`} fill="currentColor"><path d="M2 10h4v12H2V10Zm6 12V10l6-8c2 0 3 2 2 5l-1 3h5a2 2 0 0 1 2 2l-2 8a3 3 0 0 1-3 2H8Z" /></svg>;
}
ThumbIcon.propTypes = { down: PropTypes.bool, className: PropTypes.string };
