import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';

export default function AuthEmailPage({ mode }) {
    const { requestPasswordReset, resendConfirmation } = useContext(UserContext);
    const [email, setEmail] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const isRecovery = mode === 'recovery';
    const title = isRecovery ? 'Forgot password?' : 'Resend confirmation email';

    useEffect(() => {
        if (seconds <= 0) return;
        const timer = setTimeout(() => setSeconds((previous) => previous - 1), 1000);
        return () => clearTimeout(timer);
    }, [seconds]);

    async function submit(event) {
        event.preventDefault();
        if (pending || seconds > 0) return;
        setPending(true);
        setError('');
        setSent(false);
        try {
            if (isRecovery) await requestPasswordReset(email);
            else await resendConfirmation(email);
            setSent(true);
            setSeconds(60);
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
            <form onSubmit={submit} className="w-full max-w-md bg-white rounded shadow p-6 space-y-4">
                <h1 className="text-2xl font-bold">{title}</h1>
                <p>{isRecovery ? 'Enter the email address you registered with. We will send a link to choose a new password.' : 'Enter your registered email address to request another signup confirmation link.'}</p>
                <label htmlFor="account-email" className="block font-semibold">Email</label>
                <input id="account-email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} className="w-full border rounded p-2" />
                {error && <p role="alert" className="text-red-700">{error}</p>}
                {sent && <p role="status" className="text-green-700">{isRecovery ? 'If an account exists for this address, a password reset link has been sent.' : 'If this address has an account awaiting confirmation, a new confirmation link has been sent.'} Check your inbox and spam folder.</p>}
                <button type="submit" disabled={pending || seconds > 0} className="w-full bg-blue-600 text-white rounded p-2 disabled:opacity-50">{pending ? 'Sending…' : seconds > 0 ? `Try again in ${seconds}s` : isRecovery ? 'Send password reset link' : 'Resend confirmation email'}</button>
                <div className="flex flex-wrap gap-4 text-blue-700 underline">
                    <Link to="/login">Back to login</Link>
                    <Link to={isRecovery ? '/resend-confirmation' : '/forgot-password'}>{isRecovery ? 'Resend confirmation' : 'Forgot password?'}</Link>
                </div>
            </form>
        </div>
    );
}

AuthEmailPage.propTypes = { mode: PropTypes.oneOf(['recovery', 'confirmation']).isRequired };
