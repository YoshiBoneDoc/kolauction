import React from "react";
import { Link } from "react-router-dom";

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
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Ways to Donate</h2>
                <ul className="text-left text-lg text-gray-700 space-y-4">
                    <li>
                        <span className="font-bold">1. In-game Donation:</span> Send Meat or items to my in-game account: <span className="font-bold ">teres Minor (#3552305)</span>.
                    </li>
                    <li>
                        <span className="font-bold">2. PayPal:</span> Donate via PayPal <a href="https://www.paypal.com/donate/?hosted_button_id=SR8RS43MEPK42" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">here</a>.
                    </li>
                    <li>
                        <span className="font-bold">3. Contact Us:</span> For other methods, reach out via kMail
                    </li>
                </ul>
            </div>

            {/* Thank You Note */}
            <p className="text-lg text-gray-700 text-center mt-8 max-w-3xl">
                Thank you for your generosity and for supporting our community. Every contribution, big or small, helps us grow and sustain this project!
            </p>
        </div>
    );
};

export default DonatePage;