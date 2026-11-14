import PropTypes from 'prop-types';

export default function BarterSymbol({ size = 32, className = '' }) {
    return <svg className={`barter-switch-symbol ${className}`} style={{ width: size, height: size }} aria-hidden="true" viewBox="0 0 64 56" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <g transform="translate(1 0) scale(.78)">
            <path d="M18 17V8l5-5h14v15M18 8h14l5-5M32 8v13" />
            <path d="M2 23l10-6q4-2 8 0l5 2q3 1 7 1c5 0 5 5 0 5l-14-2m14 2 10-6c5-3 8 3 3 6L30 35q-4 3-9 1l-9-3q-3-1-6 1l-4 3" />
        </g>
        <g transform="translate(8 12) scale(.78)">
            <path transform="translate(-4 2)" d="M44 36c-8-7-6-17 1-13 7-4 11 5 7 10M45 23c0-5 4-8 9-7-1 5-4 7-9 6m0 1c0-3-1-5-3-6" />
            <path transform="translate(4 0)" d="m62 42-9-6c-3-2-5-2-8-.5l-5 2c-2 .8-5 .3-7 1.3-3 1.5-2 4.5 1 4.5l10-1m-10 1-11-5c-4-2-7 3-3 5.5l13 7c3 1.5 5 1 9-.3l7-2.3c2-.7 3-.7 5 .5l5 3" />
        </g>
    </svg>;
}
BarterSymbol.propTypes = { size: PropTypes.number, className: PropTypes.string };
