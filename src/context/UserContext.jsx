import { createContext, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { supabase, initialAuthLink } from "../lib/supabase";
import { createAuthService } from "../lib/auth";
import { recoveryUserForEvent } from "../lib/authLinks";
import { useNavigate } from "react-router-dom";

export const UserContext = createContext();
const auth = createAuthService(supabase);

export const UserProvider = ({ children }) => {
    const navigate = useNavigate();
    const navigateRef = useRef(navigate);
    const recoveryUserRef = useRef(null);
    useEffect(() => { navigateRef.current = navigate; }, [navigate]);
    const [recoveryUserId, setRecoveryUserId] = useState(null);
    const [session, setSession] = useState(supabase ? undefined : null);
    const [currentUser, setCurrentUser] = useState(null);
    const [hasLoaded, setHasLoaded] = useState(!supabase);
    const [authError, setAuthError] = useState("");

    useEffect(() => {
        // Remove the prototype's plaintext credentials. Supabase manages its
        // own session storage; these legacy accounts are not migrated.
        try {
            localStorage.removeItem("users");
            localStorage.removeItem("currentUser");
        } catch { /* Storage may be disabled. */ }
        if (!supabase) return;

        // Profile queries run in a separate effect, outside the auth lock.
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
            let savedUserId = recoveryUserRef.current;
            try { savedUserId = sessionStorage.getItem('khub.passwordRecovery') || savedUserId; } catch { /* Storage may be disabled. */ }
            const recoveryUser = recoveryUserForEvent(event, nextSession, savedUserId, initialAuthLink);
            recoveryUserRef.current = recoveryUser;
            setRecoveryUserId(recoveryUser);
            try {
                if (recoveryUser) sessionStorage.setItem('khub.passwordRecovery', recoveryUser);
                else sessionStorage.removeItem('khub.passwordRecovery');
            } catch { /* The reset still works in memory without storage. */ }
            if (recoveryUser && (event === 'PASSWORD_RECOVERY' || (event === 'INITIAL_SESSION' && initialAuthLink.type === 'recovery'))) {
                navigateRef.current('/reset-password', { replace: true });
            }
            setSession(nextSession ? { ...nextSession } : null);
        });
        return () => subscription.unsubscribe();
    }, []);

    useEffect(() => {
        if (session === undefined) return;
        let cancelled = false;
        setAuthError("");
        if (!session) {
            setCurrentUser(null);
            setHasLoaded(true);
            return;
        }
        setCurrentUser((previous) => previous?.id === session.user.id ? previous : null);
        auth.loadProfile(session.user)
            .then((user) => {
                if (!cancelled) setCurrentUser(user);
            })
            .catch((error) => {
                if (!cancelled) {
                    setCurrentUser(null);
                    setAuthError(error.message);
                }
            })
            .finally(() => {
                if (!cancelled) setHasLoaded(true);
            });
        return () => { cancelled = true; };
    }, [session]);

    const clearRecovery = () => {
        recoveryUserRef.current = null;
        setRecoveryUserId(null);
        try { sessionStorage.removeItem('khub.passwordRecovery'); } catch { /* Storage may be disabled. */ }
    };

    const loginUser = async (email, password) => {
        clearRecovery();
        return auth.login(email, password);
    };

    const resetPassword = async (password) => {
        if (!recoveryUserId || recoveryUserId !== session?.user?.id || initialAuthLink.error) {
            throw new Error("Open a valid password reset link from your email before changing your password.");
        }
        await auth.updatePassword(password);
        clearRecovery();
    };

    const logoutUser = async () => {
        if (!supabase) return;
        const { error } = await supabase.auth.signOut();
        if (error) setAuthError(error.message);
    };

    const changePassword = async (password) => {
        if (!currentUser || currentUser.id !== session?.user?.id) throw new Error('Log in before changing your password.');
        await auth.updatePassword(password);
    };

    return (
        <UserContext.Provider value={{
            currentUser: currentUser?.id === session?.user?.id ? currentUser : null,
            signedInUserId: session?.user?.id || null,
            registerUser: auth.register,
            loginUser,
            requestPasswordReset: auth.requestPasswordReset,
            resendConfirmation: auth.resendConfirmation,
            resetPassword,
            changePassword,
            canResetPassword: Boolean(recoveryUserId && recoveryUserId === session?.user?.id && !initialAuthLink.error),
            authLinkError: initialAuthLink.error,
            emailConfirmed: initialAuthLink.type === 'signup' && initialAuthLink.accessToken === session?.access_token && Boolean(session?.user?.email_confirmed_at),
            logoutUser,
        }}>
            {authError && (
                <div role="alert" className="bg-red-50 text-red-700 p-4">
                    {authError}{" "}
                    <button onClick={logoutUser} className="underline">Sign out</button>
                </div>
            )}
            {hasLoaded ? children : <p role="status" className="p-6">Loading your account…</p>}
        </UserContext.Provider>
    );
};

UserProvider.propTypes = { children: PropTypes.node.isRequired };
