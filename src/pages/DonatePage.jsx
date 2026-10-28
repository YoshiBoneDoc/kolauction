import { Link } from "react-router-dom";
import CopyMessage from '../components/CopyMessage';
import SiteFooter from '../components/SiteFooter';

const DonatePage = () => {
    return (
        <>
        <div className="site-page-background flex-1 bg-gray-50 flex flex-col items-center justify-center p-6">
            {/* Donate Page Content */}
            <h1 className="text-3xl font-bold text-blue-600 mb-3">Support kHub</h1>
            <p className="text-[15px] leading-6 text-gray-700 text-center max-w-3xl mb-[18px]">
                Donations help keep kHub running and support future improvements. Every contribution is appreciated!
            </p>

            {/* Donation Options */}
            <div className="w-full text-center max-w-3xl">
                <h2 className="text-xl font-bold text-gray-800 mb-3">How to Donate</h2>
                <ol className="text-left text-[15px] leading-6 text-gray-700 space-y-3">
                    <li>
                        <span className="font-bold">1. Send a KMail:</span> Address it to <span className="font-bold">kHub (#3888760)</span>.
                    </li>
                    <li>
                        <span className="font-bold">2. Enter this exact message:</span>
                        <CopyMessage text="DONATE" label="donation message" compact className="mt-1.5 w-full" />
                    </li>
                    <li>
                        <span className="font-bold">3. Attach your donation:</span> Include any items, Meat, or both, and send your KMail. No kHub account is required.
                    </li>
                </ol>
                <p className="text-left text-[15px] leading-6 text-gray-700 mt-3">
                    <span className="font-bold">Gift packages:</span> Packages without a valid auction command in the outside message are treated as donations. For bids or deposits, include the exact auction command. If you sent a package by mistake, KMail teres minor.
                </p>
                <p className="text-sm leading-tight text-gray-500 mt-[18px]">The bot will confirm your donation with a short thank-you message. Sending <span className="font-mono">DONATE</span> without attachments returns donation instructions. <em>Items or Meat sent through regular KMail without a valid command will be returned.</em></p>
            </div>

            {/* Thank You Note */}
            <p className="text-[15px] leading-6 text-gray-700 text-center mt-6 max-w-3xl">
                Thank you for your support!
            </p>
        </div>
        <div className="site-page-background bg-gray-50 px-6 pt-6 pb-12 text-center">
            <p className="text-[15px] leading-6 text-gray-700">Questions? <Link to="/support" className="text-blue-600 hover:underline">We’re here to help</Link>.</p>
        </div>
        <SiteFooter />
        </>
    );
};

export default DonatePage;
