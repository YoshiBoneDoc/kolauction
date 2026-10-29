import PropTypes from 'prop-types';
import { useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { canRelist, relistSnapshot } from '../lib/relistAuction';

export default function RelistButton({ auction, now }) {
    const { currentUser } = useContext(UserContext);
    const location = useLocation();
    if (location.pathname === '/' || !canRelist(auction, currentUser, now)) return null;
    return <Link to="/auction-item" state={{ relist: relistSnapshot(auction) }} aria-label={`Relist ${auction.item}`}
        className="relist-button relative z-10 inline-flex shrink-0 items-center justify-center rounded-md border border-[#DDBDAA] bg-[#FFFAF7] px-2.5 py-1 text-[11px] font-medium leading-4 text-[#805238] transition-colors hover:border-[#BE947C] hover:bg-[#FFF0E6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">Relist</Link>;
}
RelistButton.propTypes = { auction: PropTypes.object.isRequired, now: PropTypes.number };
