import BackHomeLinks from '../components/BackHomeLinks';
import { Link } from 'react-router-dom';
import CopyMessage from '../components/CopyMessage';

export default function Register() {
    return (
        <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4 sm:p-6">
            <section className="w-full max-w-lg bg-white rounded shadow p-6 space-y-4">
                <BackHomeLinks />
                <h1 className="text-2xl font-bold text-center">Create your kHub account</h1>
                <p>From your KoL account, send this KMail to <strong>kHub (#3888760)</strong>. No Meat or items.</p>
                <CopyMessage text="REGISTER" label="registration command" />
                <a href="https://www.kingdomofloathing.com/sendmessage.php?towho=3888760" target="_blank" rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-blue-700 underline">Open KoL KMail</a>
                <p>kHub will reply with your kHub username (KH_ followed by your KoL name) and temporary password within seconds. No email needed.</p>
                <p className="text-sm leading-relaxed text-gray-500">After your first login, click your username in the top navigation, then select “Change password.” <strong className="text-gray-700">Never reuse your KoL password.</strong></p>
                <p className="text-sm leading-relaxed text-gray-500">One account per KoL player. <span className="text-red-700">We strongly advise against attempting to circumvent a ban. You have been warned.</span></p>
                <p className="pt-2"><Link to="/login" className="text-blue-700 underline">Already registered? Log in</Link>{' · '}
                    <Link to="/forgot-password" className="text-blue-700 underline">Forgot your login?</Link></p>
            </section>
        </main>
    );
}
