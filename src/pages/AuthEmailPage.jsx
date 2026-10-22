import { Link } from 'react-router-dom';
import CopyMessage from '../components/CopyMessage';

export default function AuthEmailPage() {
    return (
        <main className="flex-1 bg-gray-50 flex items-center justify-center p-6">
            <section className="w-full max-w-lg bg-white rounded shadow p-6 space-y-4">

                <h1 className="text-2xl font-bold">Recover your kHub login</h1>
                <p>From the KoL account linked to your kHub account, send this normal KMail to <strong>kHub (#3888760)</strong>. Attach no Meat or items.</p>
                <CopyMessage text="CREDENTIALS" label="login recovery command" />
                <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-blue-700 underline">Open KoL KMail</a>
                <p>The bot sends your kHub username (KH_ followed by your KoL name) and a new temporary password. Your old password stops working when the request is processed; the bot cannot retrieve it.</p>
                <p className="text-sm text-gray-600">Requests may take a little time. Wait for the reply and allow five minutes between requests. Keep the reply private.</p>
                <p><Link to="/login" className="text-blue-700 underline">Back to login</Link>{' · '}
                    <Link to="/register" className="text-blue-700 underline">Register through kHub</Link></p>
            </section>
        </main>
    );
}
