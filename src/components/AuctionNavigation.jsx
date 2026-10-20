import { useContext } from 'react';
import { Link } from 'react-router-dom';
import useAdministrator from '../hooks/useAdministrator';
import { UserContext } from '../context/UserContext';

export default function AuctionNavigation() {
    const { currentUser, logoutUser } = useContext(UserContext);
    const isAdministrator = useAdministrator();
    return (
        <nav aria-label="Main navigation" className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 sm:gap-x-6">
                <Link to="/" className="flex min-h-11 items-center text-[#C84237]">Home</Link>
                <Link to="/auctions" className="flex min-h-11 items-center text-[#C84237]">View All Auctions</Link>
                <Link to="/auction-item" className="flex min-h-11 items-center text-[#C84237]">Auction an Item</Link>
                <Link to="/info" className="flex min-h-11 items-center text-[#C84237]">Info</Link>
                <Link to="/wall-of-shame" className="flex min-h-11 items-center text-[#C84237]">Wall of Shame</Link>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-4">
                {isAdministrator && <Link to="/admin/inbox" className="flex min-h-11 items-center text-[#C84237]">inbox</Link>}
                {currentUser ? <>
                    <div className="flex min-h-11 min-w-0 flex-col items-center justify-center text-center">
                        <Link to="/profile" className={`break-all text-[#C84237] ${isAdministrator ? 'text-base leading-none' : ''}`}>{currentUser.khubUsername || 'My Account'}</Link>
                        {isAdministrator && <>
                            <span aria-hidden="true" className="my-1 w-8 border-t border-gray-300" />
                            <span className="text-xs leading-none text-gray-500">administrator</span>
                        </>}
                    </div>
                    <button onClick={logoutUser} className="min-h-11 bg-transparent px-2 text-[#C84237]">Log Out</button>
                </> : <>
                    <Link to="/login" className="flex min-h-11 items-center text-[#C84237]">Log In</Link>
                    <Link to="/register" className="flex min-h-11 items-center text-[#C84237]">Register</Link>
                </>}
            </div>
        </nav>
    );
}
