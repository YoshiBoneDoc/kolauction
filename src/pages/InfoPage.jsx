import { Link, useLocation } from "react-router-dom";
import { useContext, useEffect } from 'react';
import { UserContext } from '../context/UserContext';
import { BID_INCREMENT_TIERS } from '../lib/bidIncrements';
import { ESCROW_FEE_TIERS, escrowFee } from '../lib/escrowFees';

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
        escrow: 'The original fee schedule ranges from 1–5%. A temporary promotion may waive or reduce fees; see current terms below. No sale, no fee.',
        direct: 'No commission. Optional tips are appreciated.',
    },
    {
        heading: 'PROTECTION',
        escrow: <>Items and leading bid Meat are secured by the bot. Verified losses caused by errors in kHub’s automated escrow system are <Link to="/auction-item#escrow-protection" className="text-blue-700 underline">fully reimbursed, without a cap</Link>. Malicious exploits and external interference are excluded.</>,
        direct: 'Players trade at their own risk. kHub cannot guarantee payment or delivery.',
    },
];

const InfoPage = () => {
    const { currentUser } = useContext(UserContext);
    const showClubHistory = Boolean(currentUser?.id) && (currentUser.isHighRollersMember === true || currentUser.isAdmin === true);
    const { hash } = useLocation();
    useEffect(() => {
        if (['#escrow-fees-title', '#buy-gift-delivery', '#buy-auctions-title', '#gift-packages', '#anti-sniping', '#bid-increases-title'].includes(hash)) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
    }, [hash]);
    return (
        <div className="site-page-background flex-1 bg-gray-50 flex flex-col items-center justify-center p-6">
            <h1 className="text-4xl font-bold text-blue-600 mb-4">About KoL Auction Hub</h1>
            <p className="w-full max-w-3xl mb-6 text-sm leading-6 text-gray-700 text-justify">
                Welcome to <span className="font-bold text-blue-500">kHub</span> (Kingdom of Loathing Auction Hub), a modern take on the old “kBay.”{' '}
                I created this site because I missed the days of putting items up for auction, without having to spend hours advertising in chat with little to show for it.{' '}
                What started as a fun little coding project over Crimbo Break somehow turned into a nearly two-year endeavor.{' '}
                But here we are, and kHub is finally ready to launch!
            </p>

            <div className="w-full max-w-3xl text-left text-sm text-gray-600">
                <p className="approval-announcement mb-6 font-medium text-gray-800">
                    <span className="text-green-700">✓</span> Officially approved by KoL management!{' '}
                    <a href="/official-approval" target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-blue-700 underline hover:text-blue-800">See For Yourself ↗</a>
                </p>
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

                <p id="gift-packages" className="mb-6 scroll-mt-4">
                    <strong>Gift Packages:</strong> HC/Ronin players can participate using gift packages with auction commands. Invalid commands are returned; packages without commands are treated as <Link to="/donate" className="font-bold text-blue-600 hover:underline">donations</Link>. Donated by accident? KMail me (teres Minor, #3552305) and I&apos;ll be happy to refund you.
                </p>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Creating an Auction
                </h2>

                <p className="mb-3">
                    Create an auction here to <Link to="/auction-item?kind=buy" className="font-medium text-blue-600 hover:underline">buy</Link> or <Link to="/auction-item?kind=sell" className="font-medium text-blue-600 hover:underline">sell</Link> items.
                </p>
                <p className="mb-6">Escrow auctions go live once the bot verifies your deposit. Follow the instructions provided after creating your auction. Direct Trade auctions go live immediately, but items must remain in your Display Case until the auction ends. Violations may result in a warning or further action. You may not bid on your own auctions.</p>

                <h2 className={`${sectionHeadingClass} mb-2`}>How to Bid</h2>
                <ul className="mb-3 list-disc space-y-1 pl-5">
                    <li>
                        <strong>Escrow:</strong> KMail kHub (#3888760) the auction’s bid command{' '}
                        <span className="inline-flex items-center gap-1 whitespace-nowrap align-middle">ex. <img src="/art/auction-bid-command.svg" alt="BID 1234" width="93" height="25" className="inline-block h-auto w-[93px] align-middle" /></span>{' '}
                        with your full bid in Meat attached.
                    </li>
                    <li><strong>Direct Trade:</strong> Bid on the website. If you win, arrange an in-game trade with the seller after the auction ends.</li>
                    <li><strong>Hardcore/Ronin:</strong> Use a gift package to send your bid. Include the exact bid command as the package’s outside message.</li>
                    <li><strong>Bid amounts:</strong> Bids cover the entire listing. Minimum bids and buyout instructions are shown on each auction page.</li>
                    <li><strong>Outbid?</strong> Escrow bids are automatically refunded. New bids require the full amount.</li>
                </ul>

                <p id="anti-sniping" className="mb-3 scroll-mt-4"><strong>Anti-sniping:</strong> Bids placed in the final minute reset the timer to 1 minute. Buyouts end auctions immediately.</p>
                <p className="mb-6"><strong>Privacy:</strong> Bidders remain anonymous during auctions, with your own bids labeled &quot;You.&quot; All bidders&apos; identities are revealed once the auction ends. Sellers are always visible, while guests and banned users cannot view player identities.</p>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Canceling Bids or Auctions
                </h2>

                <p className="mb-6">Sellers may cancel auctions <strong>before receiving any bids</strong> without penalty, with escrowed items automatically returned. Once a bid is accepted, neither the bid nor the auction can be canceled.</p>

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

                <section aria-labelledby="buy-auctions-title" className="mb-6">
                    <h2 id="buy-auctions-title" className={`${sectionHeadingClass} mb-2`}>Auctions for Buying Items</h2>
                    <ul className="list-disc space-y-2 pl-5">
                        <li><strong>Getting started:</strong> Create a Buy Auction and deposit enough Meat to cover the full order plus fees within 24 hours. Your auction begins once kHub verifies your deposit.</li>
                        <li><strong>Fulfilling orders:</strong> Sellers reserve their desired quantity on the website, then KMail the exact items using the provided message. Reservations automatically expire after 10 minutes if unfulfilled.</li>
                        <li><strong>Partial fills:</strong> Multiple sellers can contribute toward an order. Remaining quantities stay available until the auction ends or is canceled.</li>
                        <li><strong>Delivery options:</strong> Choose to receive items as they’re purchased or all at once when your auction ends.</li>
                        <li><strong>Cancellations &amp; refunds:</strong> Cancel any unfilled portion of your order at any time, without penalty. Unused Meat and fee reserves are refunded. Completed purchases and their fees are final.</li>
                        <li id="buy-gift-delivery" className="scroll-mt-4"><strong>Hardcore/Ronin:</strong> Gift packaging is free. Immediate deliveries are batched by item price: under 50 Meat (1,000 items), 50–999 (100 items), 1,000–49,999 (10 items), and 50,000+ (immediate). Once a threshold is reached, all accumulated items are sent.</li>
                    </ul>
                </section>

                <div className="mb-6 grid grid-cols-1 items-start gap-6 md:grid-cols-2 md:gap-x-8">
                    <section aria-labelledby="bid-increases-title" className="min-w-0">
                        <h2 id="bid-increases-title" className={`${sectionHeadingClass} mb-2 scroll-mt-4`}>Minimum Bid Increases</h2>
                        <div className="mb-3 space-y-1.5 leading-5">
                            <p>The first bid must meet the seller’s minimum price. Later bids must exceed the current highest bid by at least the increase below. Applies to both Escrow and Direct Trade auctions.</p>
                            <p>Buyouts can always be accepted at their listed price, even if below the next minimum bid.</p>
                        </div>
                        <div>
                            <div className="overflow-hidden rounded-md border border-gray-200">
                                <table className="w-full text-xs leading-5">
                                    <caption className="sr-only">Minimum increases and rounding units based on the current highest bid, in Meat</caption>
                                    <thead className="bg-gray-100 text-gray-700"><tr>
                                        <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-left`}>Current Bid</th>
                                        <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-right`}>Increase By</th>
                                        <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-right`}>Round To</th>
                                    </tr></thead>
                                    <tbody className="divide-y divide-gray-200">
                                        {BID_INCREMENT_TIERS.map(tier => <tr key={tier.label} className="bg-white odd:bg-gray-50">
                                            <td className="whitespace-nowrap px-2 py-1">{tier.label}</td>
                                            <td className="px-2 py-1 text-right font-medium text-gray-800">{tier.display}</td>
                                            <td className="px-2 py-1 text-right text-gray-600">{tier.roundingDisplay}</td>
                                        </tr>)}
                                    </tbody>
                                </table>
                            </div>
                            <p className="mt-2 text-xs italic leading-5">Percentage increases are rounded up to the nearest multiple shown in the “Round To” column.</p>
                            <p className="mt-2 text-xs leading-4"><strong>Example:</strong> A 3% increase on 1.75M is 52,500 Meat, rounded up to 60,000 Meat (nearest 10k). The next minimum bid is <strong>1.81M Meat.</strong></p>
                        </div>
                    </section>

                    <section aria-labelledby="escrow-fees-title" className="min-w-0">
                        <h2 id="escrow-fees-title" className={`${sectionHeadingClass} mb-2 scroll-mt-4`}>Escrow Fees</h2>
                        <p className="mb-3 rounded border-l-[3px] border-blue-300 bg-blue-50/70 px-3 py-1 text-xs leading-4 text-gray-600">These fees apply only to escrow sales. All other sales do not carry any fees.</p>
                        <div className="mb-3 space-y-1.5 leading-5">
                            <p className="text-green-800"><strong>Giving Thanks:</strong></p>
                            <p className="text-green-800">For the month of November, escrow trades are commission-free as long as you&apos;ve completed less than 20m Meat in escrow trades. If you&apos;re still below 20m, your next trade is entirely free, regardless of its value.</p>
                            <p className="text-green-800">After that, fees are 2% on the first 1b Meat and 1% on anything above 1b.</p>
                            <p className="pt-6"><em>The text below applies to the normal fee structure and isn&apos;t applicable during this promo</em></p>
                            <p><strong>Selling:</strong> A tiered commission is deducted from your final sale proceeds. Each rate applies only to the portion of the sale within that tier.</p>
                            <p><strong>Buying:</strong> Fees are calculated per item and paid by the buyer. Sellers receive the full listed price.</p>
                            <p><strong>Where do the fees go?</strong> Commissions help support the time and effort that goes into developing, improving, and maintaining kHub. A portion also goes back into the community through <Link to="/giveaways" className="text-blue-700 underline">giveaways</Link>.</p>
                        </div>
                        <details>
                            <summary className="cursor-pointer text-sm font-semibold text-gray-700">Detailed Breakdown</summary>
                            <div className="mt-3">
                                <div className="overflow-hidden rounded-md border border-gray-200">
                                    <table className="w-full text-xs leading-5">
                                        <caption className="sr-only">Tiered escrow seller commission on portions of the final sale price, in Meat</caption>
                                        <thead className="bg-gray-100 text-gray-700"><tr>
                                            <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-left`}>Sale Price Portion</th>
                                            <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-right`}>Fee Rate</th>
                                            <th scope="col" className={`${subheadingClass} px-3 py-1.5 text-right`}>Effective Rate<sup>1</sup></th>
                                        </tr></thead>
                                        <tbody className="divide-y divide-gray-200">
                                            {ESCROW_FEE_TIERS.map(tier => <tr key={tier.portion} className="bg-white odd:bg-gray-50">
                                                <td className="px-3 py-1">{tier.portion.replace(/(\d)([mb])/g, (_, amount, unit) => amount + unit.toUpperCase())}</td>
                                                <td className="px-3 py-1 text-right font-medium text-gray-800">{tier.rate}</td>
                                                <td className="px-3 py-1 text-right text-gray-800">{tier.upTo === null ? 'Approaches 1%' : `${(escrowFee(tier.upTo) / tier.upTo * 100).toFixed(2)}%`}</td>
                                            </tr>)}
                                        </tbody>
                                    </table>
                                </div>
                                <p className="mt-2 text-xs italic leading-5"><sup>1</sup> At the upper end of each price range.</p>
                                <p className="text-xs italic leading-5">Commissions are rounded down to whole Meat. <strong>No sale, no fee.</strong></p>
                                <div className="mt-2 divide-y divide-gray-200 rounded-md bg-blue-50/70 text-xs leading-4">
                                    <div className="px-3 py-2">
                                        <h3 className="font-semibold text-gray-800">Example: Selling an Item</h3>
                                        <p>A 10M Meat sale incurs:</p>
                                        <ul className="list-disc pl-4">
                                            <li>First 1M at 5% → 50,000 Meat</li>
                                            <li>Remaining 9M at 4% → 360,000 Meat</li>
                                        </ul>
                                        <p>Total commission: 410,000 Meat (4.1%)</p>
                                    </div>
                                    <div className="px-3 py-2">
                                        <h3 className="font-semibold text-gray-800">Example: Buying Items</h3>
                                        <p>Two orders totaling 10M Meat:</p>
                                        <ul className="list-disc pl-4">
                                            <li>1,000 items × 10,000 Meat → 500,000 Meat fee (5%)</li>
                                            <li>1 item × 10M Meat → 410,000 Meat fee (4.1%)</li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        </details>
                    </section>
                </div>

                <hr className="info-contact-divider mx-auto mb-5 w-[95%] opacity-60" />
                <section aria-labelledby="brief-history-title" className="mb-6">
                    <h2 id="brief-history-title" className={`${sectionHeadingClass} mb-2 text-center`}>A Brief History</h2>
                    <ul className="text-sm leading-5">
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-10-19" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Oct 19, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p>Official launch of kHub</p>
                            </div>
                        </li>
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-10-30" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Oct 30, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p>First <Link to="/giveaways" className="text-blue-700 underline dark:text-blue-300">Meat Stack Mania</Link> giveaway</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Inaugural winner: <Link to="/seller/3c088d45-3b87-46a5-b74e-10b5c49c4564?view=stats" className="font-semibold text-blue-700 underline hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200">neonep</Link></p>
                            </div>
                        </li>
                        {showClubHistory && <>
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-11-05" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Nov 5, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p>MMG High Rollers Club founded</p>
                            </div>
                        </li>
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-11-12" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Nov 12, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p>First invite-only club raffle</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Inaugural winner: — · Prize: —</p>
                            </div>
                        </li>
                        </>}
                    </ul>
                </section>

                <hr className="info-contact-divider mx-auto mb-5 w-2/3 max-w-lg" />

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
