import { useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';

export default function BackButton({ className = 'text-blue-500 hover:underline' }) {
    const navigate = useNavigate();
    function goBack() {
        // BrowserRouter tracks in-app history. A direct visit has no safe
        // previous kHub entry, so keep the visitor on the site with Home.
        if (Number.isInteger(window.history.state?.idx) && window.history.state.idx > 0) navigate(-1);
        else navigate('/', { replace: true });
    }
    return <button type="button" onClick={goBack} className={`inline-flex min-h-9 items-center rounded-none border-0 bg-transparent p-0 text-sm ${className}`}>Back</button>;
}
BackButton.propTypes = { className: PropTypes.string };
