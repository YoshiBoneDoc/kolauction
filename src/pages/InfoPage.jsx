import { Link } from "react-router-dom";

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
                Welcome to <span className="font-bold text-blue-500">kHub</span> (Kingdom of Loathing Auction Hub), a modern version of the old &quot;KoLBay.&quot;
                I created this site because I wanted a place where I could list my items up for bid just like the old days, without spending hours in chat
                advertising or refreshing the mall every minute. After not having coded for years, I also found this to be a fun little project during Crimbo Break.
            </p>

            <div className="text-sm text-gray-600 text-left max-w-3xl">
                <h2 className="text-lg font-semibold text-gray-800 mb-4 underline">PLEASE NOTE THIS IS A SOFT LAUNCH - WE ARE STILL UNDER CONSTRUCTION</h2>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How to Use This Site</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> Register on kHub and confirm your email address. Then open
                        &quot;Your Account&quot; to link the KoL account you will use for auctions.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> Get a verification code on that page and send the exact
                        message shown, <span className="font-mono">VERIFY [your code]</span>, by KMail to <span
                        className="font-bold">kHub (#3888760)</span>. Send it from your own KoL account, with no Meat or items attached.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> The bot links your account when it processes your message.
                        Codes expire after 20 minutes; you can request a new one if needed. Your account page will show when you are verified.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> Once linked, you can list items and bid using that KoL account.
                        Verification uses your KoL player ID, so your website username does not have to match your KoL name.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How to Create Auctions or Place Bids</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> Use &quot;Auction an Item&quot; to choose an item, quantity,
                        minimum bid, and duration. You may also set an optional Instant Purchase Price to end bidding early at an agreed price.
                        All prices are for the entire listing.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> After saving, follow the deposit instructions on your listing.
                        Send normal KMail to <span className="font-bold">kHub (#3888760)</span> with the exact listed items
                        and the message <span className="font-mono">LIST [Auction ID]</span>. Attach no Meat or extra items.
                        The auction becomes public and its timer starts when the bot accepts the deposit.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> Browse &quot;All Auctions&quot; and open a listing for its bidding instructions.
                        Send the bot normal KMail with <span className="font-mono">BID [Auction ID]</span> and attach
                        your full bid in Meat, with no items. Even when raising your own bid, send the full new amount, not just the difference.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> To accept an Instant Purchase Price, send <span
                        className="font-mono">BUY [Auction ID]</span> with exactly that much Meat. A bid reaching the
                        instant price also ends bidding at that price; any excess Meat is returned.
                    </li>
                    <li>
                        <span className="font-bold">5.</span> Copy the actual Auction ID and command from the listing.
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

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How Auctions Are Concluded</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> When the timer expires, or an Instant Purchase is accepted,
                        <span className="font-bold"> kHub (#3888760)</span> sends the items to the winner and the winning
                        Meat payment to the seller by KMail. Both are already held by the bot, so neither party needs to send another payment or accept a trade.
                        There is currently no auction fee.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> If there are no accepted bids, the items are returned to
                        the seller. The listing shows settlement in progress until the required deliveries are confirmed.
                        Processing and delivery depend on the bot being online; an interrupted or uncertain delivery may require manual review before it can continue.
                    </li>
                </ul>

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
