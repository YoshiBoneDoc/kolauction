import { Link } from "react-router-dom";
import { BID_INCREMENT_TIERS } from '../lib/bidIncrements';

const auctionTypeComparison = [
    {
        heading: 'ITEMS',
        escrow: 'Seller sends items to the bot before bidding begins.',
        direct: 'Seller keeps items in their Display Case throughout the auction.',
    },
    {
        heading: 'BIDDING',
        escrow: 'Buyers send bids with Meat attached via KMail. Outbid players are automatically refunded.',
        direct: 'Bids are placed in good faith on the website but are not backed by verified Meat.',
    },
    {
        heading: 'COMPLETING THE TRADE',
        escrow: 'The bot sends items and Meat to their respective recipients, or issues refunds when necessary.',
        direct: 'Both players arrange the exchange within 48 hours and confirm the outcome on kHub.',
    },
    {
        heading: 'FEES',
        escrow: '7.5% seller commission on successful sales. No sale, no fee.',
        direct: 'No commission. Optional tips are appreciated.',
    },
    {
        heading: 'PROTECTION',
        escrow: 'Items and leading bid Meat are secured by the bot. During early access, verified losses caused by our escrow system may be reimbursed up to 1M Meat per affected user.',
        direct: 'Players trade at their own risk. kHub cannot guarantee payment or delivery.',
    },
];

const InfoPage = () => {
    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
            <Link
                to="/"
                className="absolute top-4 left-4 text-blue-500 hover:underline"
            >
                Home
            </Link>
            <h1 className="text-4xl font-bold text-blue-600 mb-4">About KoL Auction Hub</h1>
            <p className="text-lg text-gray-700 text-center max-w-3xl mb-6">
                Welcome to <span className="font-bold text-blue-500">kHub</span> (Kingdom of Loathing Auction Hub), a modern take on the old “kBay.”{' '}
                I created this site because I missed the days of putting items up for auction, without having to spend hours advertising in chat with little to show for it.{' '}
                What started as a fun little coding project over Crimbo Break somehow turned into a nearly two-year endeavor.{' '}
                But here we are, and kHub is finally ready to launch!
            </p>

            <div className="text-sm text-gray-600 text-left max-w-3xl">
                <h2 className="text-lg font-semibold text-gray-800 mb-2">Getting Started</h2>
                <p className="mb-6">
                    <Link to="/register" className="font-medium text-blue-600 hover:underline">Register here</Link> to create your kHub account. Only one account is permitted per KoL player.
                </p>

                <h2 className="text-lg font-semibold text-gray-800 mb-3">Auction Types</h2>
                <div className="mb-6 overflow-hidden rounded-lg border border-[#E0E5EB] bg-white">
                    <table className="w-full table-fixed text-xs leading-5 text-[#475569]">
                        <caption className="sr-only">Escrow and Direct Trade auction comparison</caption>
                        <thead className="text-gray-800">
                            <tr>
                                <th scope="col" className="w-1/2 border-r border-t-[3px] border-r-[#E0E5EB] border-t-[#93B4E8] bg-[#EAF2FF] px-3 py-1.5 text-center font-semibold">Escrow</th>
                                <th scope="col" className="w-1/2 border-t-[3px] border-t-[#9EBFA8] bg-[#EDF5EF] px-3 py-1.5 text-center font-semibold">Direct Trade</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className="border-r border-[#E0E5EB] bg-[#F7FAFF] px-3 py-2 align-top">Our bot, kHub (#3888760), acts as the middleman, holding the items and bid Meat during the auction.</td>
                                <td className="bg-[#F7FBF8] px-3 py-2 align-top">Buyers and sellers exchange items and Meat directly after the auction ends.</td>
                            </tr>
                        </tbody>
                        {auctionTypeComparison.map(({ heading, escrow, direct }) => (
                            <tbody key={heading}>
                                <tr>
                                    <th scope="rowgroup" colSpan={2} className="border-y border-[#E5E7EB] bg-[#F1F3F6] px-3 py-[3px] text-center text-[11px] leading-4 font-semibold">{heading}</th>
                                </tr>
                                <tr className="bg-white">
                                    <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">{escrow}</td>
                                    <td className="px-3 py-2 align-top">{direct}</td>
                                </tr>
                            </tbody>
                        ))}
                    </table>
                </div>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">Bidding Privacy</h2>
                <p className="mb-6">Bidders remain anonymous while an auction is active, with your own bids labeled as “You.” Seller identities are visible to help buyers make informed decisions, while winning bidders are revealed only after the auction ends. All player identities are hidden from guests and banned users.</p>

                <section aria-labelledby="bid-increases-title" className="mb-6">
                    <h2 id="bid-increases-title" className="mb-2 text-lg font-semibold text-gray-800">Minimum Bid Increases</h2>
                    <p className="mb-3">The first bid must meet the seller’s minimum price. Each subsequent bid must exceed the current highest bid by at least the amount shown below. These rules apply to both Escrow and Direct Trade auctions.</p>
                    <div className="max-w-md overflow-hidden rounded-md border border-gray-200">
                        <table className="w-full text-xs leading-5">
                            <caption className="sr-only">Minimum increases based on the current highest bid, in Meat</caption>
                            <thead className="bg-gray-100 text-gray-700"><tr>
                                <th scope="col" className="px-3 py-1.5 text-left font-semibold">Current Highest Bid</th>
                                <th scope="col" className="px-3 py-1.5 text-right font-semibold">Required Increase</th>
                            </tr></thead>
                            <tbody className="divide-y divide-gray-200">
                                {BID_INCREMENT_TIERS.map(tier => <tr key={tier.label} className="bg-white odd:bg-gray-50">
                                    <td className="whitespace-nowrap px-3 py-1">{tier.label}</td>
                                    <td className="px-3 py-1 text-right font-medium text-gray-800">{tier.display}</td>
                                </tr>)}
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-2 text-xs leading-5">Buyouts can always be accepted at their listed price, even if below the next minimum bid.</p>
                </section>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">Creating and Bidding on Escrow Auctions</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> Use &quot;Auction an Item&quot; to choose an item, quantity,
                        minimum bid, and duration. You may also set an optional Buyout Price to end bidding early at an agreed price.
                        All prices are for the entire listing.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> After saving, follow the deposit instructions on your listing.
                        Send normal KMail to <span className="font-bold">kHub (#3888760)</span> with the exact listed items
                        and the message <span className="font-mono">LIST [Auction number]</span>. Attach no Meat or extra items.
                        The auction becomes public and its timer starts when the bot accepts the deposit.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> Browse &quot;All Auctions&quot; and open a listing for its bidding instructions.
                        Send the bot normal KMail with <span className="font-mono">BID [Auction number]</span> and attach
                        your full bid in Meat, with no items. Even when raising your own bid, send the full new amount, not just the difference.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> If the listing offers a Buyout Price, use the same <span
                        className="font-mono">BID [Auction number]</span> message and attach that amount or more.
                        This ends bidding at the buyout price; any excess Meat is returned.
                    </li>
                    <li>
                        <span className="font-bold">5.</span> Copy the short auction number and command from the listing.
                        A bid or purchase counts only when the bot processes the funded KMail before the deadline.
                        The bot holds the leading bid and returns the previous leading bidder&apos;s Meat when they are outbid.
                    </li>
                    <li>
                        <span className="font-bold">6.</span> Use normal, unwrapped KMail for all auction commands.
                        <span className="font-bold underline"> All gift packages sent to kHub are considered donations.</span>
                        Gifts do not count as deposits or bids. Rejected normal auction messages have their attached Meat and items returned by the bot.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How Do I Cancel My Bid or Auction?</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> You may cancel your auction from its listing page before
                        any bids have been accepted, without a cancellation penalty.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> If the bot already holds your items, it will return them
                        by KMail after cancellation. If you have not deposited them yet, there is nothing to return.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> Accepted bids cannot be canceled, and a seller cannot
                        cancel an auction once it has an accepted bid.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> If you are outbid, the bot automatically returns your
                        full previous bid by KMail. You do not need to request a refund.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How Escrow Auctions Are Concluded</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> When the timer expires or a buyout is accepted,
                        <span className="font-bold"> kHub (#3888760)</span> sends the items to the winner and the winning
                        Meat payment to the seller by KMail. Both are already held by the bot, so neither party needs to send another payment or accept a trade.
                        New escrow listings have a 7.5% seller fee, deducted from the final sale price and rounded down to whole Meat. No sale, no fee. Existing listings retain the fee agreed when created. Direct trades have no compulsory fee.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> If there are no accepted bids, the items are returned to
                        the seller. The listing shows settlement in progress until the required deliveries are confirmed.
                    </li>
                </ul>

                <p className="mb-6 text-xs italic">Refunds and deliveries typically arrive within seconds, but may take longer during outages or other service disruptions.</p>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">Contact Us</h2>
                <p>
                    If you have any further questions, feel free to send a kMail to my main account: <span
                    className="font-bold">Teres Minor (#3552305)</span>.
                </p>
            </div>
        </div>
    );
};

export default InfoPage;
