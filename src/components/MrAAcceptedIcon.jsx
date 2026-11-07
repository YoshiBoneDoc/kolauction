import PropTypes from 'prop-types';

export default function MrAAcceptedIcon({ tiny = false }) {
    return <img src="/art/mr-a-accepted.svg?v=2" alt="Accepts Mr. A payments" title="Accepts Mr. A payments" draggable={false}
        className={`${tiny ? 'h-7 w-8' : 'h-10 w-12'} inline-block shrink-0 !rounded-none !border-0 !bg-transparent !p-0 object-contain !opacity-100 !shadow-none !outline-none`} />;
}

MrAAcceptedIcon.propTypes = { tiny: PropTypes.bool };
