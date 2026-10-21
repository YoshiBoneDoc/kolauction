import BackHomeLinks from '../components/BackHomeLinks';
import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';

export default function ConfirmEmail() {
    const { currentUser, emailConfirmed, authLinkError } = useContext(UserContext);
    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
            <div className="w-full max-w-md bg-white rounded shadow p-6 space-y-4">
                <BackHomeLinks />
                <h1 className="text-2xl font-bold">Email confirmation</h1>
                {authLinkError ? <p role="alert" className="text-red-700">{authLinkError}</p>
                    : emailConfirmed ? <p role="status" className="text-green-700">Your email address is confirmed. You can now use your account.</p>
                        : currentUser ? <p>You are already signed in. You can continue to your account.</p>
                            : <p>Open the confirmation link from your email, or request a new link below.</p>}
                <div className="flex flex-wrap gap-4 text-blue-700 underline">
                    <Link to={currentUser ? '/' : '/login'}>{currentUser ? 'Continue home' : 'Log in'}</Link>
                    <Link to="/resend-confirmation">Resend confirmation email</Link>
                </div>
            </div>
        </div>
    );
}
