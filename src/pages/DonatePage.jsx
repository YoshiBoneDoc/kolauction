import { Link } from "react-router-dom";
import CopyMessage from '../components/CopyMessage';

const DonatePage = () => {
    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
            {/* Link back to Home */}
            <Link
                to="/"
                className="absolute top-4 left-4 text-blue-500 hover:underline"
            >
                Home
            </Link>

            {/* Donate Page Content */}
            <h1 className="text-4xl font-bold text-blue-600 mb-4">Support kHub</h1>
            <p className="text-lg text-gray-700 text-center max-w-3xl mb-6">
                Thank you for considering a donation to support <span className="font-bold text-blue-500">kHub</span>. Your contributions help keep this platform running and improve the features for all users.
            </p>

            {/* Donation Options */}
            <div className="text-center max-w-3xl">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">How to Donate</h2>
                <ul className="text-left text-lg text-gray-700 space-y-4">
                    <li>
                        <span className="font-bold">1. Send a KMail:</span> Address it to <span className="font-bold">kHub (#3888760)</span> in Kingdom of Loathing.
                    </li>
                    <li>
                        <span className="font-bold">2. Write this exact message:</span>
                        <CopyMessage text="DONATE" label="donation message" className="mt-2" />
                    </li>
                    <li>
                        <span className="font-bold">3. Attach your donation:</span> Add the Meat, items, or both that you would like to donate, then send the KMail. You do not need a linked website account.
                    </li>
                    <li>
                        <span className="font-bold">Gift packages:</span> All gift packages sent to kHub are also considered donations, regardless of their message. Use normal, unwrapped KMail with the listing&apos;s command for auction deposits and bids.
                    </li>
                </ul>
                <p className="text-lg text-gray-700 mt-6">The bot sends a short thank-you after processing your donation. Sending <span className="font-mono">DONATE</span> without attachments returns donation instructions.</p>
                <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex min-h-11 items-center text-lg text-blue-500 hover:underline">Open KoL KMail</a>
                <p className="text-lg text-gray-700 mt-4">Questions? Send a KMail to <span className="font-bold">teres Minor (#3552305)</span>.</p>
            </div>

            {/* Thank You Note */}
            <p className="text-lg text-gray-700 text-center mt-8 max-w-3xl">
                Thank you for your generosity and for supporting our community. Every contribution, big or small, helps us grow and sustain this project!
            </p>
        </div>
    );
};

export default DonatePage;
