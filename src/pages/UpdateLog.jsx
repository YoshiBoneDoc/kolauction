import { Link } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';

export default function UpdateLog() {
    return <div className="flex flex-1 flex-col">
        <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8 sm:px-6">
            <h1 className="text-3xl font-bold text-blue-700">Update Log</h1>
            <ul className="list-disc space-y-4 pl-5 text-gray-700">
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
