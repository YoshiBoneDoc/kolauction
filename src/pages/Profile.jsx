import WinnerLink from '../components/WinnerLink';
import { useContext } from "react";
import { UserContext } from "../context/UserContext";
import { AuctionsContext } from "../context/AuctionsContext";
import { Link } from "react-router-dom";
import { getAuctionResult, getAuctionStatus } from "../lib/auctionLifecycle";
import KolVerification from "../components/KolVerification";
import { formatCompactMeat } from '../lib/formatMeat';
import { useNow } from "../hooks/useNow";

const formatNumber = (number) => number.toLocaleString('en-US');

const formatTimeLeft = (endTime, now) => {
    const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s left`;
};

const Profile = () => {
    const { currentUser } = useContext(UserContext);
    const { auctions, isLoading } = useContext(AuctionsContext);
    const now = useNow();

    if (!currentUser) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
                <p className="text-red-500 text-xl font-bold mb-4">You must be logged in to view your profile.</p>
                <Link to="/login" className="text-blue-500 hover:underline text-lg">Log In</Link>
            </div>
        );
    }
    if (isLoading) return <p role="status" className="p-6">Loading your auction history…</p>;

    const selling = auctions.filter((auction) => auction.sellerId === currentUser.id);
    const bidding = auctions.filter((auction) => auction.bids.some((bid) => bid.bidderId === currentUser.id));
    const awaitingTrades = auctions.filter((auction) => {
        const result = getAuctionResult(auction, now);
        return result.status === 'awaiting_trade'
            && (auction.sellerId === currentUser.id || result.winnerId === currentUser.id);
    });
    const completedSales = selling.filter((auction) => auction.status === 'completed');
    const completedPurchases = auctions.filter((auction) => auction.status === 'completed' && auction.winnerId === currentUser.id);
    const totalMeatGain = completedSales.reduce((sum, auction) => sum + BigInt(auction.finalPrice ?? 0) - BigInt(auction.escrowMode ? (auction.feeMeat || 0) : 0), 0n);
    const totalMeatSpent = completedPurchases.reduce((sum, auction) => sum + BigInt(auction.finalPrice ?? 0), 0n);
    const sections = [
        { title: 'Awaiting item deposit', records: selling.filter((auction) => auction.status === 'pending_escrow') },
        { title: 'Sending escrow deliveries', records: auctions.filter((auction) => auction.status === 'settling' && (auction.sellerId === currentUser.id || auction.winnerId === currentUser.id)) },
        { title: 'Awaiting settlement', records: awaitingTrades },
        { title: 'Active listings', records: selling.filter((auction) => getAuctionStatus(auction, now) === 'active') },
        { title: 'Active bids', records: bidding.filter((auction) => getAuctionStatus(auction, now) === 'active') },
        { title: 'Listing history', records: selling.filter((auction) => !['active','pending_escrow','settling'].includes(getAuctionStatus(auction, now))) },
        { title: 'Bid history', records: bidding.filter((auction) => !['active','settling'].includes(getAuctionStatus(auction, now))) },
    ];

    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <Link to="/" className="text-blue-500 underline">Home</Link>
            <h1 className="text-4xl font-bold text-blue-600 my-6 text-center">{currentUser.khubUsername}&apos;s Profile</h1>
            <p className="mb-4 text-center"><Link to="/change-password" className="text-blue-700 underline">Change password</Link></p>
            {selling.some(auction => auction.status !== 'pending_escrow') && <p className="mb-4 text-center"><Link to={`/seller/${currentUser.id}`} className="text-blue-700 underline">View public seller profile</Link></p>}
            <KolVerification />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                <div className="bg-white rounded shadow p-4">
                    <h2 className="font-semibold">Completed sales</h2>
                    <p>{formatCompactMeat(totalMeatGain)} Meat received</p>
                </div>
                <div className="bg-white rounded shadow p-4">
                    <h2 className="font-semibold">Completed purchases</h2>
                    <p>{formatCompactMeat(totalMeatSpent)} Meat spent</p>
                </div>
            </div>
            <p className="text-sm text-gray-600 mb-6">Totals include completed bot deliveries (seller fees deducted) and direct trades confirmed by both parties. Pending deliveries are shown below.</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {sections.map(({ title, records }) => (
                    <section key={title}>
                        <h2 className="text-2xl font-bold border-b mb-4 pb-2">{title}</h2>
                        {records.length === 0 && <p className="text-gray-600">Nothing here yet.</p>}
                        <div className="space-y-3">
                            {records.map((auction) => {
                                const result = getAuctionResult(auction, now);
                                const myBids = auction.bids.filter((bid) => bid.bidderId === currentUser.id);
                                return (
                                    <Link key={auction.id} to={`/auction/${auction.id}`} className="block rounded shadow border bg-white p-4">
                                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                            <h3 className="font-bold">{auction.item} × {formatNumber(auction.quantity)}</h3>
                                            {result.status === 'active' && (
                                                <time
                                                    dateTime={new Date(auction.endTime).toISOString()}
                                                    title={`Ends ${new Date(auction.endTime).toLocaleString()}`}
                                                    className={`text-sm tabular-nums ${auction.endTime - now <= 3 * 60 * 60 * 1000 ? 'text-red-600' : 'text-gray-600'}`}
                                                >
                                                    {formatTimeLeft(auction.endTime, now)}
                                                </time>
                                            )}
                                        </div>
                                        <p>{result.label} · {auction.escrowMode ? 'Escrow' : 'Direct settlement'}</p>
                                        {result.status === 'active' && (
                                            <p>Current bid: {auction.currentBid > 0 ? `${formatCompactMeat(auction.currentBid)} Meat` : 'No bids yet'}</p>
                                        )}
                                        {result.hasWinner && <p>Winner: <WinnerLink auction={auction} /> · Final price: {formatCompactMeat(result.finalPrice)} Meat</p>}
                                        {myBids.length > 0 && <p>Your highest bid: {formatCompactMeat(Math.max(...myBids.map((bid) => bid.amount)))} Meat</p>}
                                        {result.status === 'awaiting_trade' && (
                                            <p className="text-blue-700 mt-2">{auction.sellerId === currentUser.id ? 'You are the seller.' : result.winnerId === currentUser.id ? 'You won this auction.' : 'Another bidder won.'} View trade details</p>
                                        )}
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
};

export default Profile;
