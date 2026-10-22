import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';

export default function ResetPassword() {
    const { currentUser, canResetPassword, resetPassword, changePassword, authLinkError } = useContext(UserContext);
    const allowed = Boolean(currentUser) || (canResetPassword && !authLinkError);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [updated, setUpdated] = useState(false);

    async function submit(event) {
        event.preventDefault();
        if (pending || !allowed) return;
        setError('');
        if (password !== confirmation) {
            setError('The passwords do not match.');
            return;
        }
        setPending(true);
        try {
            if (canResetPassword && !authLinkError) await resetPassword(password);
            else await changePassword(password);
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
        <div className="flex-1 bg-gray-50 flex items-center justify-center p-6">
            <div className="w-full max-w-md bg-white rounded shadow p-6 space-y-4">
                <h1 className="text-2xl font-bold">Choose a new password</h1>
                {updated ? (
                    <>
                        <p role="status" className="text-green-700">Your password has been updated. Use the new password the next time you log in.</p>
                        <Link to="/" className="text-blue-700 underline">Return home</Link>
                    </>
                ) : !allowed ? (
                    <>
                        <p role="alert">Log in to change your password, or recover your login through kHub KMail.</p>
                        <Link to="/forgot-password" className="text-blue-700 underline">Recover your login</Link>
                    </>
                ) : (
                    <form onSubmit={submit} className="space-y-4">
                        <label htmlFor="new-password" className="block font-semibold">New password</label>
                        <input id="new-password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} className="w-full border rounded p-2" />
                        <p className="text-sm text-gray-600">Use at least 12 characters and a unique password. Never reuse your KoL password.</p>
                        <label htmlFor="confirm-password" className="block font-semibold">Confirm new password</label>
                        <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="w-full border rounded p-2" />
                        {error && <p role="alert" className="text-red-700">{error}</p>}
                        <button type="submit" disabled={pending} className="w-full bg-blue-600 text-white rounded p-2 disabled:opacity-50">{pending ? 'Updating…' : 'Update password'}</button>
                    </form>
                )}
            </div>
        </div>
    );
}
