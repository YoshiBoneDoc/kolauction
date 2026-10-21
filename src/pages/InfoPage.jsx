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

                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    Official kHub Accounts
                </h2>

                <p className="mb-3">
                    <strong>kHub (#3888760)</strong> is our official auction bot, and{' '}
                    <strong>Teres Minor (#3552305)</strong> is the site administrator.
                </p>

                <p className="mb-6">
                    Only send auction-related items and Meat to <strong>kHub (#3888760)</strong>.
                    Ignore messages from other accounts claiming to represent kHub,
                    particularly those requesting items, Meat, or account information.
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

                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    Creating an Auction
                </h2>

                <p className="mb-3">
                    <Link to="/auction-item" className="font-medium text-blue-600 hover:underline">
                        Create an auction here
                    </Link>
                    . Minimum Bid and Buyout Prices are optional. All prices apply to the entire listing, not individual items.
                </p>

                <p className="mb-2 font-semibold">
                    When does the auction timer start?
                </p>

                <ul className="mb-6 list-disc space-y-2 pl-5">
                    <li>
                        <strong>Escrow:</strong> Your auction goes live once our bot receives and verifies your items,
                        typically within seconds. Deposit instructions are provided on your auction&apos;s page
                        and are visible only to you.
                    </li>
                    <li>
                        <strong>Direct Trade:</strong> Your auction goes live immediately after publishing.
                        Items must remain in your Display Case throughout the auction.
                        Violations may result in a warning or further action.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    Canceling Bids or Auctions
                </h2>

                <ul className="mb-6 list-disc space-y-2 pl-5">
                    <li>
                        <strong>Canceling an Auction:</strong> Sellers may cancel an auction before
                        any bids have been accepted, without penalty. Escrowed items will be
                        automatically returned by KMail.
                    </li>
                    <li>
                        <strong>Canceling a Bid:</strong> Accepted bids cannot be canceled.
                        Once an auction receives a bid, the seller can no longer cancel their sale.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    After an Auction Ends
                </h2>

                <ul className="mb-3 list-disc space-y-2 pl-5">
                    <li>
                        <strong>Escrow:</strong> The bot automatically sends the items to the winning bidder
                        and the seller&apos;s proceeds by KMail. A 7.5% commission is deducted from
                        the final sale price. If no bids were accepted, the items are returned to the seller.
                    </li>
                    <li>
                        <strong>Direct Trade:</strong> The seller and winning bidder have 48 hours to complete
                        their exchange. Both parties must confirm the outcome on kHub to close out the auction.

                        <p className="mt-2 rounded border-l-[3px] border-blue-300 bg-blue-50/70 px-3 py-1 text-xs leading-4 text-gray-600">
                            <span className="font-semibold text-gray-700">Deadline exceptions:</span>{' '}
                            Extensions may be granted by mutual agreement or when one party
                            makes a good-faith effort to complete the trade but is delayed
                            by the other.
                        </p>
                    </li>
                </ul>
                <p className="mb-6 text-xs italic">
                    Escrow deliveries and refunds typically arrive within seconds, but may be delayed during service disruptions.
                </p>


                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    Trade Enforcement &amp; Ban Policy
                </h2>
                <p className="mb-3">
                    Direct Trade auctions are binding commitments. Failure to honor a trade
                    may result in the following penalties:
                </p>
                <ul className="mb-3 list-disc space-y-2 pl-5">
                    <li>
                        <strong>First offense:</strong> 14-day ban.
                    </li>
                    <li>
                        <strong>Second offense:</strong> 30-day or permanent ban.
                    </li>
                    <li>
                        <strong>Serious or deliberate violations:</strong> Immediate permanent ban.
                    </li>
                </ul>
                <p className="mb-6">
                    All violations are subject to administrator review. Penalties depend on
                    the circumstances, auction value, and prior offenses. False reports
                    and attempts to evade bans may result in additional penalties.
                </p>


                <h2 className="text-lg font-semibold text-gray-800 mb-2">
                    Contact Us
                </h2>

                <p>
                    Need help with something not covered above? Submit a [support ticket].
                </p>

                {/* TODO: Hyperlink "Submit a support ticket" to the "Other" admin mailbox. */}
            </div>
        </div>
    );
};

export default InfoPage;
