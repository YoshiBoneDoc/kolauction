import React from "react";
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
                Welcome to <span className="font-bold text-blue-500">kHub</span> (Kingdom of Loathing Auction Hub), a modern version of the old "KoLBay."
                I created this site because I wanted a place where I could list my items up for bid just like the old days, without spending hours in chat advertising or refreshing the mall every minute. After not having coded for years, I also found this to be a fun little project during Crimbo Break.
            </p>

            <div className="text-sm text-gray-600 text-left max-w-3xl">
                <h2 className="text-lg font-semibold text-gray-800 mb-4 underline">PLEASE NOT THIS IS A SOFT LAUNCH - WE ARE STILL UNDER CONSTRUCTION</h2>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How to Use This Site</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> Register using a valid username on the site. Your username
                        on kHub must match <span className="font-bold underline">exactly</span> with your KoL name for
                        verification.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> kMail <span
                        className="font-bold">[SOME USERNAME HERE]</span> with the text: <span className="font-mono">verify registration [kHub Username]</span>.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> The site will verify your registration within 48 hours.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> Once registered and verified, you can start creating
                        auctions and placing bids.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How to Create Auctions or Place Bids</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> Create auctions using the "Auction an Item" page.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> Place bids on the "All Auctions" page or an individual
                        auction's page.
                    </li>
                    <li>
                        <span className="font-bold">3.</span> For auctions, send a trade offer (and leave it pending for
                        as long as the auction is active) with the item or bid amount in Meat to <span
                        className="font-bold">[SOME USERNAME HERE]</span>.
                    </li>
                    <li>
                        <span className="font-bold">4.</span> Include the text: <span className="font-mono">[Your Username] auction [Auction Item and Quantity]</span> (case
                        insensitive) in the trade's message for auctions.
                    </li>
                    <li>
                        <span className="font-bold">5.</span> Include the text: <span className="font-mono">[Your Username] bid [Auction Item and Quantity]</span> (case
                        insensitive) in the trade's message for bids.
                    </li>
                    <li>
                        <span className="font-bold">6.</span> Auctions and bids must be verified before they appear
                        publicly.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How Do I Cancel My Bid or Auction?</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> The easiest way to cancel your auction is to cancel the
                        trade in-game. If this happens for any reason (whether intentional or otherwise) before the time
                        of the auction has concluded, your auction on the site will be removed. <span
                        className="font-bold underline">Please note, you will not be able to place an auction for 24 hours if you cancel your auction early.</span>
                    </li>
                    <li>
                        <span className="font-bold">2.</span> Bids may not be canceled once they are placed. If you
                        retract your trade offer with your bid, <span className="font-bold underline">you will not be allowed to bid on any auctions for 24 hours.</span>
                    </li>
                    <li>
                        <span className="font-bold">3.</span> If another user bids higher than your current bid on any
                        individual auction, the bot will cancel your trade offer and your Meat will be refunded.
                    </li>
                </ul>

                <h2 className="text-lg font-semibold text-gray-800 mb-4">How Auctions Are Concluded</h2>
                <ul className="mb-6 list-none space-y-2">
                    <li>
                        <span className="font-bold">1.</span> After the auction timer expires, our bot <span
                        className="font-bold">[SOME USERNAME HERE]</span> will act as the middleman, accepting trades
                        from both the seller and buyer. The bot will then send the respective items/Meat to each party.
                        A 2% courtesy fee will be deducted for successful transactions.
                    </li>
                    <li>
                        <span className="font-bold">2.</span> Sellers and buyers have 24 hours after the auction ends to
                        respond to the initial trade offer. Once both parties have accepted, the bot will finalize the
                        trade. Winnings can be collected at any time thereafter.
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