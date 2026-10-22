import BackHomeLinks from '../components/BackHomeLinks';
import { Link, useLocation } from "react-router-dom";
import { useEffect } from 'react';
import { BID_INCREMENT_TIERS } from '../lib/bidIncrements';
import { ESCROW_FEE_TIERS } from '../lib/escrowFees';

const sectionHeadingClass = 'text-lg font-semibold leading-7 text-gray-800';
const subheadingClass = 'text-sm font-semibold leading-5 text-gray-700';

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
        escrow: 'Fees start at 5% and decrease for higher-value sales. See chart below for full details. No sale, no fee.',
        direct: 'No commission. Optional tips are appreciated.',
    },
    {
        heading: 'PROTECTION',
        escrow: 'Items and leading bid Meat are secured by the bot. During early access, verified losses caused by our escrow system may be reimbursed up to 1M Meat per affected user.',
        direct: 'Players trade at their own risk. kHub cannot guarantee payment or delivery.',
    },
];

const InfoPage = () => {
    const { hash } = useLocation();
    useEffect(() => {
        if (hash === '#escrow-fees-title') document.getElementById('escrow-fees-title')?.scrollIntoView({ block: 'start' });
    }, [hash]);
    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 pt-16">
            <BackHomeLinks className="absolute top-4 left-4" />
            <h1 className="text-4xl font-bold text-blue-600 mb-4">About KoL Auction Hub</h1>
            <p className="w-full max-w-3xl mb-6 text-sm leading-6 text-gray-700 text-justify">
                Welcome to <span className="font-bold text-blue-500">kHub</span> (Kingdom of Loathing Auction Hub), a modern take on the old “kBay.”{' '}
                I created this site because I missed the days of putting items up for auction, without having to spend hours advertising in chat with little to show for it.{' '}
                What started as a fun little coding project over Crimbo Break somehow turned into a nearly two-year endeavor.{' '}
                But here we are, and kHub is finally ready to launch!
            </p>

            <div className="w-full max-w-3xl text-left text-sm text-gray-600">
                <h2 className={`${sectionHeadingClass} mb-2`}>Getting Started</h2>
                <p className="mb-6">
                    <Link to="/register" className="font-medium text-blue-600 hover:underline">Register here</Link> to create your kHub account. Only one account is permitted per KoL player.
                </p>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Official kHub Accounts
                </h2>

                <p className="mb-3">
                    <strong>kHub (#3888760)</strong> is our official auction bot, and{' '}
                    <strong>Teres Minor (#3552305)</strong> is the site’s creator and administrator.{' '}
                    No other accounts are authorized to contact you on behalf of kHub.{' '}
                    Ignore any messages claiming otherwise, especially those requesting items, Meat, or account information.
                </p>

                <p className="mb-3">
                    Please send only auction-related items and Meat to <strong>kHub (#3888760)</strong>, following the KMail instructions provided on the site.{' '}
                    Items or Meat sent without the required KMail message will be automatically returned.
                </p>

                <p className="mb-6">
                    The only exceptions are <Link to="/donate" className="text-blue-600 hover:underline">donations</Link> and gift packages, which are treated as donations.
                </p>


                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Creating an Auction
                </h2>

                <p className="mb-3">
                    <Link to="/auction-item" className="font-medium text-blue-600 hover:underline">
                        Create an auction here
                    </Link>
                    . Minimum Bid and Buyout Prices are optional. All prices apply to the entire listing, not individual items.
                </p>

                <h3 className={`${subheadingClass} mb-2`}>
                    When does an auction go live?
                </h3>

                <ul className="mb-6 list-disc space-y-2 pl-5">
                    <li>
                        <strong className={subheadingClass}>Escrow:</strong> Your auction goes live once our bot receives and verifies your items,
                        typically within seconds. Deposit instructions are provided on your auction&apos;s page
                        and are visible only to you.
                    </li>
                    <li>
                        <strong className={subheadingClass}>Direct Trade:</strong> Your auction goes live immediately after publishing.
                        Items must remain in your Display Case throughout the auction.
                        Violations may result in a warning or further action.
                    </li>
                </ul>

                <h2 className={`${sectionHeadingClass} mb-4`}>Bidding Privacy</h2>
                <p className="mb-6">Bidders remain anonymous while an auction is active, with your own bids labeled as “You.” Seller identities are visible to help buyers make informed decisions, while winning bidders are revealed only after the auction ends. All player identities are hidden from guests and banned users.</p>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Canceling Bids or Auctions
                </h2>

                <ul className="mb-6 list-disc space-y-2 pl-5">
                    <li>
                        <strong className={subheadingClass}>Canceling an Auction:</strong> Sellers may cancel an auction before
                        any bids have been accepted, without penalty. Escrowed items will be
                        automatically returned by KMail.
                    </li>
                    <li>
                        <strong className={subheadingClass}>Canceling a Bid:</strong> Accepted bids cannot be canceled.
                        Once an auction receives a bid, the seller can no longer cancel their sale.
                    </li>
                </ul>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    After an Auction Ends
                </h2>

                <ul className="mb-3 list-disc space-y-2 pl-5">
                    <li>
                        <strong className={subheadingClass}>Escrow:</strong> The bot automatically sends the items to the winning bidder
                        and the seller&apos;s proceeds by KMail. The seller commission is deducted from
                        the final sale price (see the fee chart below). If no bids were accepted, the items are returned to the seller.
                    </li>
                    <li>
                        <strong className={subheadingClass}>Direct Trade:</strong> The seller and winning bidder have 48 hours to complete
                        their exchange. Both parties must confirm the outcome on kHub to close out the auction.

                        <p className="mt-2 rounded border-l-[3px] border-blue-300 bg-blue-50/70 px-3 py-1 text-xs leading-4 text-gray-600">
                            <span className={subheadingClass}>Deadline exceptions:</span>{' '}
                            Extensions may be granted by mutual agreement or when one party
                            makes a good-faith effort to complete the trade but is delayed
                            by the other.
                        </p>
                    </li>
                </ul>
                <p className="mb-6 text-xs italic">
                    Escrow deliveries and refunds typically arrive within seconds, but may be delayed during service disruptions.
                </p>


                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Trade Enforcement &amp; Ban Policy
                </h2>
                <p className="mb-3">
                    Direct Trade auctions are binding commitments. Failure to honor a trade
                    may result in the following penalties:
                </p>
                <ul className="mb-3 list-disc space-y-2 pl-5">
                    <li>
                        <strong className={subheadingClass}>First offense:</strong> 14-day ban.
                    </li>
                    <li>
                        <strong className={subheadingClass}>Second offense:</strong> 30-day or permanent ban.
                    </li>
                    <li>
                        <strong className={subheadingClass}>Serious or deliberate violations:</strong> Immediate permanent ban.
                    </li>
                </ul>
                <p className="mb-6">
                    All violations are subject to administrator review. Penalties depend on
                    the circumstances, auction value, and prior offenses. False reports
                    and attempts to evade bans may result in additional penalties.
                </p>


                <h2 className={`${sectionHeadingClass} mb-3`}>Auction Types</h2>
                <div className="mb-6 overflow-hidden rounded-lg border border-[#E0E5EB] bg-white">
                    <table className="w-full table-fixed text-xs leading-5 text-[#475569]">
                        <caption className="sr-only">Escrow and Direct Trade auction comparison</caption>
                        <thead className="text-gray-800">
                            <tr>
                                <th scope="col" className={`${subheadingClass} w-1/2 border-r border-t-[3px] border-r-[#E0E5EB] border-t-[#93B4E8] bg-[#EAF2FF] px-3 py-1.5 text-center`}>Escrow</th>
                                <th scope="col" className={`${subheadingClass} w-1/2 border-t-[3px] border-t-[#9EBFA8] bg-[#EDF5EF] px-3 py-1.5 text-center`}>Direct Trade</th>
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
                                    <th scope="rowgroup" colSpan={2} className={`${subheadingClass} border-y border-[#E5E7EB] bg-[#F1F3F6] px-3 py-[3px] text-center`}>{heading}</th>
                                </tr>
                                <tr className="bg-white">
                                    <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">{escrow}</td>
                                    <td className="px-3 py-2 align-top">{direct}</td>
                                </tr>
                            </tbody>
                        ))}
                    </table>
                </div>

                <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-x-8 md:gap-y-0">
                    <section aria-labelledby="bid-increases-title" className="min-w-0 md:row-span-3 md:grid md:grid-rows-subgrid">
                        <h2 id="bid-increases-title" className={`${sectionHeadingClass} mb-2`}>Minimum Bid Increases</h2>
                        <p className="mb-3 leading-5">The first bid must meet the seller’s minimum price. Later bids must exceed the current highest bid by at least the increase below. Applies to both Escrow and Direct Trade auctions.</p>
                        <div>
                            <div className="overflow-hidden rounded-md border border-gray-200">
                                <table className="w-full text-xs leading-5">
                                    <caption className="sr-only">Minimum increases based on the current highest bid, in Meat</caption>
                                    <thead className="bg-gray-100 text-gray-700"><tr>
                                        <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-left`}>Current Highest Bid</th>
                                        <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-right`}>Required Increase</th>
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
                        </div>
                    </section>

                    <section aria-labelledby="escrow-fees-title" className="min-w-0 md:row-span-3 md:grid md:grid-rows-subgrid">
                        <h2 id="escrow-fees-title" className={`${sectionHeadingClass} mb-2 scroll-mt-4`}>Escrow Seller Fees</h2>
                        <p className="mb-3 leading-5">Fees are based on the final winning bid or accepted buyout. Each rate applies only to the portion within that tier, so higher-value sales have a lower overall fee percentage.</p>
                        <div>
                            <div className="overflow-hidden rounded-md border border-gray-200">
                                <table className="w-full text-xs leading-5">
                                    <caption className="sr-only">Tiered escrow seller commission on portions of the final sale price, in Meat</caption>
                                    <thead className="bg-gray-100 text-gray-700"><tr>
                                        <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-left`}>Sale Price Portion</th>
                                        <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-right`}>Fee Rate</th>
                                    </tr></thead>
                                    <tbody className="divide-y divide-gray-200">
                                        {ESCROW_FEE_TIERS.map(tier => <tr key={tier.portion} className="bg-white odd:bg-gray-50">
                                            <td className="px-3 py-1">{tier.portion}</td>
                                            <td className="px-3 py-1 text-right font-medium text-gray-800">{tier.rate}</td>
                                        </tr>)}
                                    </tbody>
                                </table>
                            </div>
                            <p className="mt-2 text-xs leading-5"><strong>Example:</strong> A 10m sale costs 5% of the first 1m (50k), plus 4% of the remaining 9m (360k): <strong>410k Meat total (4.1%).</strong></p>
                            <p className="mt-2 text-xs leading-5">The total fee is rounded down to whole Meat. No sale, no fee.</p>
                        </div>
                    </section>
                </div>

                <h2 className={`${sectionHeadingClass} mb-1 text-center`}>
                    Contact Us
                </h2>

                <p className="text-center">
                    Need help with something not covered above? <Link to="/support" className="text-blue-600 hover:underline">Submit a support ticket</Link>.
                </p>

            </div>
        </div>
    );
};

export default InfoPage;
