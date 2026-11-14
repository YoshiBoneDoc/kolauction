import { Link, useLocation } from "react-router-dom";
import { useContext, useEffect } from 'react';
import { UserContext } from '../context/UserContext';
import { BID_INCREMENT_TIERS } from '../lib/bidIncrements';

const sectionHeadingClass = 'text-lg font-semibold leading-7 text-gray-800';
const subheadingClass = 'text-sm font-semibold leading-5 text-gray-700';

const InfoPage = () => {
    const { currentUser } = useContext(UserContext);
    const showClubHistory = Boolean(currentUser?.id) && (currentUser.isHighRollersMember === true || currentUser.isAdmin === true);
    const { hash } = useLocation();
    useEffect(() => {
        if (['#escrow-fees-title', '#buy-gift-delivery', '#buy-auctions-title', '#gift-packages', '#anti-sniping', '#bid-increases-title'].includes(hash)) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
    }, [hash]);
    return (
        <div className="site-page-background flex-1 bg-gray-50 flex flex-col items-center justify-center p-6">
            <h1 className="info-page-title font-bold text-blue-600 mb-4">About KoL Auction Hub</h1>
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


                <div className="mb-3">
                    <p className="py-1">
                        <strong>kHub (#3888760)</strong> - official auction bot
                    </p>
                    <div className="my-1 w-[52%] border-t border-gray-200/30" />
                    <p className="py-1">
                        <strong>Teres Minor (#3552305)</strong> - site creator and administrator
                    </p>
                </div>


                <p className="mb-3">
                    No other accounts represent kHub. Ignore messages claiming otherwise,
                    especially those requesting items, Meat, or account information.
                    Only send auction-related items and Meat to <strong>kHub (#3888760)</strong> using
                    the site&apos;s KMail instructions. Transfers without a valid KMail command
                    will be automatically returned.
                </p>

                <p id="gift-packages" className="mb-6 scroll-mt-4">
                    <strong>Gift Packages:</strong> HC/Ronin players can participate using gift packages with auction commands. Invalid commands are returned; packages without commands are treated as <Link to="/donate" className="font-bold text-blue-600 hover:underline">donations</Link>. Donated by accident? KMail me (teres Minor, #3552305) and I&apos;ll be happy to refund you.
                </p>

                <h2 className={`${sectionHeadingClass} mb-2`}>
                    Creating an Auction
                </h2>

                <p className="mb-3">
                    Create an auction to <Link to="/auction-item?kind=buy" className="font-medium text-blue-600 hover:underline">buy</Link> or <Link to="/auction-item?kind=sell" className="font-medium text-blue-600 hover:underline">sell</Link> items.
                </p>
                <p className="mb-6">Escrow auctions go live once the bot verifies your deposit. Follow the instructions provided after creating your auction. Direct Trade auctions go live immediately, but items must remain in your Display Case until the auction ends. Violations may result in a warning or further action. You may not bid on your own auctions.</p>

                <h2 className={`${sectionHeadingClass} mb-2`}>How to Bid</h2>
                <ul className="mb-3 list-disc space-y-1 pl-5">
                    <li>
                        <strong>Escrow:</strong> KMail kHub (#3888760) the auction’s bid command{' '}
                        <span className="inline-flex items-center gap-1 whitespace-nowrap align-middle">ex. <img src="/art/auction-bid-command.svg" alt="BID 1234" width="93" height="25" className="inline-block h-auto w-[83px] align-middle" /></span>{' '}
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
                        <strong className={subheadingClass}>Escrow:</strong> Our bot automatically delivers items to the winner and proceeds to the seller, minus commission. Unsold items are returned or automatically relisted, if enabled at creation.                    <p className="mb-4 text-xs italic">
                        Escrow deliveries and refunds typically arrive within seconds, but may be delayed during service disruptions.
                    </p>
                    </li>
                    <li>
                        <strong className={subheadingClass}>Direct Trade:</strong> The seller and winning bidder have 48 hours to complete the exchange and confirm the outcome on kHub.
                        <p className="mt-2 rounded border-l-[3px] border-blue-300 bg-blue-50/70 px-3 py-1 text-xs leading-4 text-gray-600">
                            <span className={subheadingClass}>Deadline exceptions:</span>{' '}
                            Extensions may be granted by mutual agreement or if one party delays the other&apos;s good-faith efforts to complete the trade.
                        </p>
                    </li>
                    <li>
                        <strong>Relist unsold auctions:</strong> Go to Your Name (top right) → My Auctions → Listing History and select Relist. Escrow auctions are automatically relisted if enabled at creation.
                    </li>
                </ul>

                <h2 className={`${sectionHeadingClass} mt-6 mb-2`}>
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
                        <caption className="sr-only">
                            Escrow and Direct Trade auction comparison
                        </caption>

                        <thead className="text-gray-800">
                        <tr>
                            <th
                                scope="col"
                                className={`${subheadingClass} w-1/2 border-r border-t-[3px] border-r-[#E0E5EB] border-t-[#93B4E8] bg-[#EAF2FF] px-3 py-1.5 text-center`}
                            >
                                Escrow
                            </th>
                            <th
                                scope="col"
                                className={`${subheadingClass} w-1/2 border-t-[3px] border-t-[#9EBFA8] bg-[#EDF5EF] px-3 py-1.5 text-center`}
                            >
                                Direct Trade
                            </th>
                        </tr>
                        </thead>

                        <tbody>
                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] bg-[#F7FAFF] px-3 py-2 align-top">
                                <strong>Items:</strong> Bot holds items during the auction.
                            </td>
                            <td className="bg-[#F7FBF8] px-3 py-2 align-top">
                                <strong>Items:</strong> Seller keeps items in their Display Case.
                            </td>
                        </tr>

                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">
                                <strong>Bidding:</strong> KMail with command and Meat attached.
                                Outbid players are refunded automatically.
                            </td>
                            <td className="px-3 py-2 align-top">
                                <strong>Bidding:</strong> Good faith bids placed on website but not backed by Meat.
                            </td>
                        </tr>

                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">
                                <strong>Completion:</strong> Bot automatically delivers
                                items and seller proceeds, and issues refunds as needed.
                            </td>
                            <td className="px-3 py-2 align-top">
                                <strong>Completion:</strong> Players trade directly within
                                48 hours and confirm on kHub.
                            </td>
                        </tr>

                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">
                                <strong>Unsold Auctions:</strong> Automatically relisted if enabled; otherwise items are returned.
                            </td>
                            <td className="px-3 py-2 align-top">
                                <strong>Unsold Auctions:</strong> Sellers can manually relist their auctions.
                            </td>
                        </tr>

                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">
                                <strong>Fees:</strong> 1–4% commission, subject to promotions.
                                No sale, no fee.
                            </td>
                            <td className="px-3 py-2 align-top">
                                <strong>Fees:</strong> No commission. Optional tips appreciated.
                            </td>
                        </tr>

                        <tr className="border-t border-[#E0E5EB]">
                            <td className="border-r border-[#E0E5EB] px-3 py-2 align-top">
                                <strong>Protection:</strong> Bot secures items and leading
                                bid Meat. Verified losses caused by kHub&apos;s escrow
                                system are <a href="/auction-item#escrow-protection" className="underline">
                                fully reimbursed, without a cap
                            </a>.
                            </td>
                            <td className="px-3 py-2 align-top">
                                <strong>Protection:</strong> Players trade at their own risk.
                                kHub cannot guarantee payment or delivery.
                            </td>
                        </tr>
                        </tbody>
                    </table>
                </div>


                <section aria-labelledby="buy-auctions-title" className="mt-5 mb-6">
                    <h2 id="buy-auctions-title" className={`${sectionHeadingClass} mb-2`}>
                        Auctions for Buying Items
                    </h2>

                    <ul className="list-disc space-y-2 pl-5">
                        <li>
                            <strong>Getting started:</strong> Create a <Link to="/auction-item?kind=buy" className="font-medium text-blue-600 hover:underline">Buy Auction</Link> and deposit the order amount plus a fee reserve within 24 hours. The auction activates once the deposit is verified.
                        </li>

                        <li>
                            <strong>Fulfilling orders:</strong> Sellers reserve a quantity on the
                            website, then KMail the items using the provided command.
                            Reservations expire after 10 minutes.
                        </li>

                        <li>
                            <strong>Partial fills:</strong> Multiple sellers can fulfill an order.
                            Remaining quantities stay available until the auction ends or is canceled.
                        </li>

                        <li>
                            <strong>Delivery:</strong> Choose to receive items as they’re purchased or all at once when your auction ends.
                        </li>

                        <li>
                            <strong>Cancellations &amp; refunds:</strong> Cancel any unfilled portion
                            without penalty. Unused Meat and fee reserves are refunded;
                            completed purchases are final.
                        </li>



                        <li id="buy-gift-delivery" className="scroll-mt-4">
                            <strong>Hardcore/Ronin:</strong> Send a gift package with the provided
                            command as the outside message and any required Meat attached to start the auction.

                            <p className="ml-4 mt-1 text-xs italic text-gray-500">
                                Gift packaging is free, but immediate deliveries are batched by item price:
                                under 50 Meat (1,000 items), 50–999 (100 items),
                                1,000–49,999 (10 items), and 50,000+ (immediate).
                                Items are sent once the threshold is reached.
                            </p>
                        </li>
                    </ul>
                </section>



                <div className="mt-8 mb-6 grid grid-cols-1 items-start gap-6 md:grid-cols-2 md:gap-x-8">
                    <section aria-labelledby="bid-increases-title" className="min-w-0">
                        <h2
                            id="bid-increases-title"
                            className={`${sectionHeadingClass} mb-2 scroll-mt-4`}
                        >
                            Minimum Bid Increases
                        </h2>

                        <p className="mb-3 leading-5">
                            First bids must meet the seller&apos;s minimum price.
                            Subsequent bids follow the increases below for both auction types.
                            Buyouts bypass minimum bid increases.
                        </p>

                        <div className="overflow-hidden rounded-md border border-gray-200">
                            <table className="w-full text-xs leading-5">
                                <caption className="sr-only">
                                    Minimum bid increases and rounding units in Meat
                                </caption>
                                <thead className="bg-gray-100 text-gray-700">
                                <tr>
                                    <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-left`}>
                                        Current Bid
                                    </th>
                                    <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-right`}>
                                        Increase By
                                    </th>
                                    <th scope="col" className={`${subheadingClass} whitespace-nowrap px-2 py-1.5 text-right`}>
                                        Round To
                                    </th>
                                </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                {BID_INCREMENT_TIERS.map(tier => (
                                    <tr key={tier.label} className="bg-white odd:bg-gray-50">
                                        <td className="whitespace-nowrap px-2 py-1">
                                            {tier.label}
                                        </td>
                                        <td className="px-2 py-1 text-right font-medium text-gray-800">
                                            {tier.display}
                                        </td>
                                        <td className="px-2 py-1 text-right text-gray-600">
                                            {tier.roundingDisplay}
                                        </td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                        </div>

                        <p className="mt-2 text-xs italic leading-5">
                            Percentage increases are rounded up to the nearest multiple shown.
                        </p>
                        <p className="mt-2 text-xs leading-4">
                            <strong>Example:</strong> 3% of 1.75M is 52,500 Meat,
                            rounded up to 60k. Next minimum bid:{' '}
                            <strong>1.81M Meat.</strong>
                        </p>
                    </section>

                    <section aria-labelledby="escrow-fees-title" className="min-w-0">
                        <h2
                            id="escrow-fees-title"
                            className={`${sectionHeadingClass} mb-2 scroll-mt-4`}
                        >
                            Escrow Fees
                        </h2>

                        <p className="mb-3 rounded border-l-[3px] border-blue-300 bg-blue-50/70 px-3 py-1 text-xs leading-4 text-gray-600">
                            Fees apply only to escrow auctions. Direct Trades are free.
                        </p>

                        <div className="mb-3 space-y-1.5 leading-5">

                            <div className="space-y-2 text-[13px] leading-5">
                                <p className="font-semibold text-green-800">
                                    Giving Thanks: November Promotion
                                </p>

                                <p className="text-green-800">
                                    Your first 20M Meat in escrow sales is commission-free.
                                    If you&apos;re below 20M, your entire next trade is entirely free,
                                    regardless of value.
                                </p>

                                <p className="text-green-800">
                                    After that, commission is 2% on the first 1B Meat
                                    and 1% above 1B.
                                </p>
                            </div>

                            <p className="mt-3 border-t border-gray-200/30 pt-3 text-xs italic">
                                The normal fee schedule below does not apply during the promo.
                            </p>
                            <p>Escrow fees are based on your loyalty tier, and all earned tier benefits are permanent.</p>

                            <p>
                                <strong>Selling:</strong> Commission is deducted from sale
                                proceeds based on the listed rates.
                            </p>

                            <p>
                                <strong>Buying:</strong> Buyers pay per-item fees from their fee reserve. Sellers receive the full listed price.
                            </p>

                            <p>
                                <strong>Where do the fees go?</strong> They help support the time and effort that goes into developing, improving, and maintaining kHub, with a portion going toward community {' '}
                                <Link to="/giveaways" className="text-blue-700 underline">
                                    giveaways
                                </Link>.
                            </p>
                        </div>



                        <details>
                            <summary className="cursor-pointer text-sm font-semibold text-gray-700">
                                Detailed Breakdown
                            </summary>

                            <div className="mt-3">
                                <div className="overflow-hidden rounded-md border border-gray-200">
                                    <table className="w-full table-fixed text-xs leading-5">
                                        <caption className="sr-only">
                                            Flat escrow commission rates by sale price and loyalty tier
                                        </caption>
                                        <colgroup>
                                            <col className="w-[54%]" />
                                            <col className="w-[23%]" />
                                            <col className="w-[23%]" />
                                        </colgroup>
                                        <thead className="divide-y divide-gray-200 bg-gray-100 text-gray-700">
                                        <tr>
                                            <th
                                                scope="col"
                                                className={`${subheadingClass} px-3 py-1.5 text-left`}
                                            >
                                                Sale Price
                                            </th>
                                            <th
                                                scope="colgroup"
                                                colSpan={2}
                                                className={`${subheadingClass} px-3 py-1.5 text-center`}
                                            >
                                                Fee Rate
                                            </th>
                                        </tr>
                                        <tr>
                                            <td aria-hidden="true" />
                                            <th scope="col" className="px-1 py-0.5 text-center text-xs font-normal leading-4 text-gray-700">Base</th>
                                            <th scope="col" className="px-1 py-0.5 text-center text-xs font-normal leading-4 text-gray-700">At Max Tier</th>
                                        </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200">
                                        {[
                                            { portion: 'Below 10M', rate: '5%', maxRate: '2%' },
                                            { portion: '10M–100M', rate: '4%', maxRate: '1.5%' },
                                            { portion: '100M–1B', rate: '3%', maxRate: '1%' },
                                            { portion: '1B+', rate: '2%', maxRate: '0.5%' },
                                        ].map(tier => (
                                            <tr key={tier.portion} className="bg-white odd:bg-gray-50">
                                                <td className="px-3 py-1">{tier.portion}</td>
                                                <td className="px-1 py-1 text-center font-medium text-gray-800">
                                                    {tier.rate}
                                                </td>
                                                <td className="px-1 py-1 text-center font-medium text-gray-800">
                                                    {tier.maxRate}
                                                </td>
                                            </tr>
                                        ))}
                                        </tbody>
                                    </table>
                                </div>

                                <p className="mt-2 text-xs italic leading-5">
                                    The applicable rate applies to the entire sale.{' '}
                                    <strong>No sale, no fee.</strong>
                                    <br />
                                    Leaderboard perks may further reduce fees.
                                </p>

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
                                <p>First <Link to="/giveaways" className="text-blue-700 underline dark:text-blue-300">Meat Stack Mania</Link> giveaway</p><p className="mt-0.5 text-[0.875em] leading-tight text-gray-500 dark:text-gray-400">Inaugural winner: <Link to="/seller/3c088d45-3b87-46a5-b74e-10b5c49c4564?view=stats" className="font-semibold text-blue-700 underline hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200">neonep</Link></p>
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
                                <p>First invite-only club raffle</p><p className="mt-0.5 text-[0.875em] leading-tight text-gray-500 dark:text-gray-400">Winner: <Link to="/seller/3bb6eb2a-41d1-4090-9dc1-d5fe1cfa2e58" className="font-semibold text-blue-700 underline hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200">XionXIV</Link> · Prize: do-it-yourself laser eye surgery kit</p>
                            </div>
                        </li>
                        </>}
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-11-13" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Nov 13, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p><Link to="/leaderboards" className="text-blue-700 underline dark:text-blue-300">Leaderboards</Link> Introduced</p>
                            </div>
                        </li>
                        <li className="group grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[124px_minmax(0,1fr)] sm:gap-x-3">
                            <time dateTime="2026-11-15" className="pt-0.5 text-xs text-gray-500 dark:text-gray-400">Nov 15, 2026</time>
                            <div className="relative min-w-0 pb-4 pl-4 text-gray-700 group-last:pb-0 dark:text-gray-200">
                                <span aria-hidden="true" className="absolute -bottom-[9px] left-0 top-[9px] w-px -translate-x-1/2 bg-gray-300 group-last:hidden dark:bg-gray-600" />
                                <span aria-hidden="true" className="absolute left-0 top-1.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-gray-400 dark:bg-gray-500" />
                                <p>First public Mystery Raffle held</p>
                                <p className="mt-0.5 text-[0.875em] leading-tight text-gray-500 dark:text-gray-400">Winner: — · Prize: —</p>
                            </div>
                        </li>
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
