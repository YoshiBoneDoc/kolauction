import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';

export default function ResetPassword() {
    const { canResetPassword, resetPassword, authLinkError } = useContext(UserContext);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [updated, setUpdated] = useState(false);

    async function submit(event) {
        event.preventDefault();
        if (pending || !canResetPassword) return;
        setError('');
        if (password !== confirmation) {
            setError('The passwords do not match.');
            return;
        }
        setPending(true);
        try {
            await resetPassword(password);
            setPassword('');
            setConfirmation('');
            setUpdated(true);
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    }

    return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
            <div className="w-full max-w-md bg-white rounded shadow p-6 space-y-4">
                <h1 className="text-2xl font-bold">Choose a new password</h1>
                {updated ? (
                    <>
                        <p role="status" className="text-green-700">Your password has been updated. Use the new password the next time you log in.</p>
                        <Link to="/" className="text-blue-700 underline">Return home</Link>
                    </>
                ) : !canResetPassword || authLinkError ? (
                    <>
                        <p role="alert">{authLinkError || 'Open a valid password reset link from your email to continue. This link may be missing, expired, or already used.'}</p>
                        <Link to="/forgot-password" className="text-blue-700 underline">Request a new password reset link</Link>
                    </>
                ) : (
                    <form onSubmit={submit} className="space-y-4">
                        <label htmlFor="new-password" className="block font-semibold">New password</label>
                        <input id="new-password" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} className="w-full border rounded p-2" />
                        <label htmlFor="confirm-password" className="block font-semibold">Confirm new password</label>
                        <input id="confirm-password" type="password" autoComplete="new-password" minLength={6} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="w-full border rounded p-2" />
                        {error && <p role="alert" className="text-red-700">{error}</p>}
                        <button type="submit" disabled={pending} className="w-full bg-blue-600 text-white rounded p-2 disabled:opacity-50">{pending ? 'Updating…' : 'Update password'}</button>
                    </form>
                )}
            </div>
        </div>
    );
}
