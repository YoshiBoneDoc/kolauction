import { useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { activeNavigationPath } from '../lib/navigation';
import useAdministrator from '../hooks/useAdministrator';
import { UserContext } from '../context/UserContext';

export default function AuctionNavigation() {
    const { currentUser, restrictedAccount, logoutUser } = useContext(UserContext);
    const account = currentUser || restrictedAccount;
    const isAdministrator = useAdministrator();
    const { pathname } = useLocation();
    const activePath = activeNavigationPath(pathname);
    const linkProps = (to) => ({
        to,
        'aria-current': activePath === to ? 'page' : undefined,
        className: 'site-nav-link flex min-h-11 items-center whitespace-nowrap text-[#C84237]',
    });
    // Hide separators on narrow screens so wrapped rows never leave stray dots.
    const separator = <span aria-hidden="true" className="hidden text-base font-semibold leading-none text-slate-500 sm:inline">·</span>;
    return (
        <nav aria-label="Main navigation" className="site-navigation mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 text-sm">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 sm:gap-x-3">
                <Link {...linkProps("/")}>Home</Link>
                {separator}
                <Link {...linkProps("/auctions")}>View All Auctions</Link>
                {separator}
                <Link {...linkProps("/auction-item")}>Create Auction</Link>
                {separator}
                <Link {...linkProps("/info")}>Info</Link>
                {separator}
                <Link {...linkProps("/wall-of-shame")}>Wall of Shame</Link>
            </div>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-4 sm:gap-x-3">
                {isAdministrator && <><Link {...linkProps("/admin/inbox")}>Inbox</Link>{separator}</>}
                {account ? <>
                    <div className="flex min-h-11 min-w-0 max-w-[12rem] flex-col items-center justify-center text-center">
                        <Link to={restrictedAccount ? "/" : "/profile"} aria-current={!restrictedAccount && activePath === "/profile" ? "page" : undefined} className={`site-nav-link break-all text-[#C84237] ${isAdministrator ? 'text-base leading-none' : ''}`}>{account.khubUsername || 'My Account'}</Link>
                        {isAdministrator && <>
                            <span aria-hidden="true" className="my-1 w-8 border-t border-gray-300" />
                            <span className="text-xs leading-none text-gray-500">administrator</span>
                        </>}
                    </div>
                    {separator}
                    <button onClick={logoutUser} className="min-h-11 bg-transparent px-2 text-[#C84237]">Log Out</button>
                </> : <>
                    <Link {...linkProps("/login")}>Log In</Link>
                    {separator}
                    <Link {...linkProps("/register")}>Register</Link>
                </>}
            </div>
        </nav>
    );
}
