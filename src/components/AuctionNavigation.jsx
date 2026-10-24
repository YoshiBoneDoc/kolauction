import { useContext, useEffect, useRef, useState } from 'react';
import ThemeToggle from './ThemeToggle';
import { Link, useLocation } from 'react-router-dom';
import { activeNavigationPath } from '../lib/navigation';
import useAdministrator from '../hooks/useAdministrator';
import { UserContext } from '../context/UserContext';

export default function AuctionNavigation() {
    const { currentUser, restrictedAccount, logoutUser } = useContext(UserContext);
    const account = currentUser || restrictedAccount;
    const isAdministrator = useAdministrator();
    const location = useLocation();
    const { pathname } = location;
    const [expandedAt, setExpandedAt] = useState(null);
    const menuOpen = expandedAt === location.key;
    const menuButton = useRef(null);
    const navigation = useRef(null);
    useEffect(() => {
        if (!menuOpen) return;
        const onKeyDown = event => {
            if (event.key !== 'Escape') return;
            setExpandedAt(null);
            menuButton.current?.focus();
        };
        const onPointerDown = event => {
            if (!navigation.current?.contains(event.target)) setExpandedAt(null);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown);
        };
    }, [menuOpen]);
    const activePath = activeNavigationPath(pathname);
    const linkProps = (to) => ({
        to,
        'aria-current': activePath === to ? 'page' : undefined,
        onClick: () => setExpandedAt(null),
        className: 'site-nav-link flex min-h-11 items-center whitespace-nowrap text-[#C84237]',
    });
    // Hide separators on narrow screens so wrapped rows never leave stray dots.
    const separator = <span aria-hidden="true" className="hidden text-base font-semibold leading-none text-slate-500 lg:inline">·</span>;
    return (
        <nav ref={navigation} aria-label="Main navigation" className="site-navigation mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm lg:py-3">
            <Link {...linkProps("/")}>Home</Link>
            <div className="ml-auto flex items-center lg:order-last lg:ml-0">
                {separator}
                <ThemeToggle />
            </div>
            <button ref={menuButton} type="button" aria-expanded={menuOpen} aria-controls="main-navigation-links"
                onClick={() => setExpandedAt(menuOpen ? null : location.key)}
                className="mobile-menu-toggle inline-flex min-h-11 items-center gap-2 border-0 bg-transparent px-2 text-gray-600 lg:hidden">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-5 w-5">
                    <path strokeLinecap="round" d={menuOpen ? 'M6 6l12 12M6 18L18 6' : 'M4 6h16M4 12h16M4 18h16'} />
                </svg>
                {menuOpen ? 'Close' : 'Menu'}
            </button>
            <div id="main-navigation-links" className={`${menuOpen ? 'flex' : 'hidden'} w-full min-w-0 flex-col gap-2 border-t border-gray-300 pb-2 pt-2 lg:flex lg:w-auto lg:flex-1 lg:flex-row lg:items-center lg:justify-between lg:gap-x-6 lg:border-0 lg:p-0`}>
                <div className="mobile-primary-links grid min-w-0 grid-cols-2 gap-x-4 lg:flex lg:flex-wrap lg:items-center lg:gap-x-3">
                    <span aria-hidden="true" className="hidden text-base font-semibold leading-none text-slate-500 lg:inline">·</span>
                    <Link {...linkProps("/auctions")}>View All Auctions</Link>
                    {separator}
                    <Link {...linkProps("/auction-item")}>Create Auction</Link>
                    {separator}
                    <Link {...linkProps("/info")}>Info</Link>
                    {separator}
                    <Link {...linkProps("/wall-of-shame")}>Wall of Shame</Link>
                </div>
                <div className="mobile-account-links flex min-w-0 max-w-full flex-wrap items-center gap-x-4 border-t border-gray-300 pt-2 lg:ml-auto lg:justify-end lg:gap-x-3 lg:border-0 lg:pt-0">
                    {isAdministrator && <><Link {...linkProps("/admin/inbox")}>Inbox</Link>{separator}</>}
                    {account ? <>
                        <div className="flex min-h-11 min-w-0 max-w-[12rem] flex-1 flex-col items-start justify-center lg:flex-none lg:items-center lg:text-center">
                            <Link to={restrictedAccount ? "/" : "/profile"} onClick={() => setExpandedAt(null)} title={account.khubUsername || 'My Account'} aria-current={!restrictedAccount && activePath === "/profile" ? "page" : undefined} className={`site-nav-link flex min-h-11 max-w-full flex-col items-start justify-center text-[#C84237] lg:items-center ${isAdministrator ? 'text-base leading-none' : ''}`}>
                                <span className="max-w-full truncate">{account.khubUsername || 'My Account'}</span>
                                {isAdministrator && <>
                                    <span aria-hidden="true" className="my-1 hidden w-8 border-t border-gray-300 lg:block" />
                                    <span className="mt-1 text-xs leading-none text-gray-500 lg:mt-0">administrator</span>
                                </>}
                            </Link>
                        </div>
                        {separator}
                        <button onClick={() => { setExpandedAt(null); logoutUser(); }} className="min-h-11 bg-transparent px-2 text-[#C84237]">Log Out</button>
                    </> : <>
                        <Link {...linkProps("/login")}>Log In</Link>
                        {separator}
                        <Link {...linkProps("/register")}>Register</Link>
                    </>}
                </div>
            </div>
        </nav>
    );
}
