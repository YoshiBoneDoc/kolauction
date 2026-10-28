import { Link } from 'react-router-dom';
import { useContext } from 'react';
import { UserContext } from '../context/UserContext';
import SiteFooter from '../components/SiteFooter';

export default function UpdateLog() {
    const { currentUser } = useContext(UserContext);
    return <div className="flex flex-1 flex-col">
        <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8 sm:px-6">
            <h1 className="text-3xl font-bold text-blue-700">Update Log</h1>
            <ul className="list-disc space-y-4 pl-5 text-gray-700">
                <li>Refreshed the <Link to="/profile" className="text-blue-700 underline">Account Profile</Link> and <Link to={currentUser ? `/seller/${currentUser.id}?view=stats` : '/login'} className="text-blue-700 underline">Seller Profile</Link> pages with cleaner layouts and easier navigation.</li>
                <li>Added growing KoL Meat stacks to your <Link to="/profile" className="text-blue-700 underline">Account Profile</Link>! Watch your stack grow as your total Meat traded reaches new milestones.</li>
                <li>Gave Buy Auction pages a much-needed makeover with a cleaner layout and simplified escrow information.</li>
                <li>Updated our Escrow Protection Guarantee. Reimbursement limits have been removed, and the guarantee is now permanent rather than limited to Early Access. <Link to="/auction-item#escrow-protection" className="text-blue-700 underline">View the updated policy ↗</Link></li>
                <li>Gift items, including fake hands, heart-shaped necklaces, stuffed items, and more, can now be listed in Buy and Sell auctions.</li>
                <li>Made several performance improvements to significantly reduce lag, freezing, and timeouts when browsing auctions.</li>
                <li>Individual auction pages now have a link to the wiki and pricegun pages for that specific item.</li>
                <li>Individual auction pages now display approximate Mall prices, updated daily.</li>
                <li>Hardcore/Ronin players can use <Link to="/info#gift-packages" className="text-blue-700 underline">gift packages</Link> for bidding and starting auctions. Include the exact auction command in the outside message. <em>All other gift packages without these commands will still be considered donations.</em></li>
                <li>Introduced <Link to="/info#anti-sniping" className="text-blue-700 underline">Anti-Sniping</Link>.</li>
                <li>Now supports Dark Mode</li>
                <li>Logged-in users can now see every bidder’s username once a trade is completed and the items have been exchanged. Until then, concluded auctions reveal only the winning bidder.</li>
                <li>Buy Auctions are here! They work much like Sell Auctions, with a few differences. Visit the <Link to="/info#buy-auctions-title" className="text-blue-700 underline">Info page</Link> for details. Buy Auctions are available through Escrow only for now.</li>
                <li>Adjusted how the <Link to="/info#bid-increases-title" className="text-blue-700 underline">minimum bid</Link> required to raise an existing bid is calculated.</li>
                <li>Adjusted Escrow fees. See the <Link to="/info#escrow-fees-title" className="text-blue-700 underline">fee table</Link> for the updated rates.</li>
            </ul>
        </main>
        <SiteFooter />
    </div>;
}
