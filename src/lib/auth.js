import { getAuthRedirectUrls } from "./authLinks.js";

export function createAuthService(client, { origin } = {}) {
    function requireClient() {
        if (!client) {
            throw new Error("Account services are not configured yet. Please try again later.");
        }
        return client;
    }

    function redirects() {
        return getAuthRedirectUrls(origin ?? globalThis.location?.origin);
    }

    function validateEmail(email) {
        const normalized = email.trim().toLowerCase();
        if (normalized.length > 254 || !/^\S+@\S+\.\S+$/.test(normalized)) {
            throw new Error("Please enter a valid email address.");
        }
        return normalized;
    }

    function emailError(error) {
        if (error.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error.code)) {
            return new Error("Too many email requests. Please wait a few minutes before trying again.");
        }
        return new Error(error.message || "The email could not be sent. Please try again later.");
    }

    function rejectConflicts(conflicts) {
        if (conflicts?.username_taken && conflicts?.email_taken) {
            throw new Error("This KHub username and email address are already registered. Please log in or use different details.");
        }
        if (conflicts?.username_taken) {
            throw new Error("This KHub username is already registered. Please choose another username.");
        }
        if (conflicts?.email_taken) {
            throw new Error("This email address is already registered. Please log in.");
        }
    }

    return {
        async register({ khubUsername, email, password }) {
            const username = khubUsername.trim();
            const normalizedEmail = email.trim().toLowerCase();
            if (!username || username.length > 16) {
                throw new Error("KHub username must contain 1–16 characters.");
            }
            if (!normalizedEmail || password.length < 6) {
                throw new Error("Enter an email address and a password of at least 6 characters.");
            }
            const api = requireClient();
            const check = await api.rpc('registration_conflicts', {
                p_username: username, p_email: normalizedEmail,
            });
            if (check.error || typeof check.data?.username_taken !== 'boolean' || typeof check.data?.email_taken !== 'boolean') {
                throw new Error("Registration is temporarily unavailable. Please try again later.");
            }
            rejectConflicts(check.data);

            const { data, error } = await api.auth.signUp({
                email: normalizedEmail,
                password,
                options: { data: { khub_username: username }, emailRedirectTo: redirects().confirmation },
            });
            if (error) {
                if (['user_already_exists', 'email_exists'].includes(error.code) || /user already registered/i.test(error.message)) {
                    rejectConflicts({ email_taken: true });
                }
                if (error.code === "unexpected_failure" || /database error saving new user/i.test(error.message)) {
                    // A competing signup may have claimed the name after
                    // our first check; the unique index remains authoritative.
                    const latest = await api.rpc('registration_conflicts', {
                        p_username: username, p_email: normalizedEmail,
                    });
                    if (!latest.error) rejectConflicts(latest.data);
                    throw new Error("Could not create your profile. The KHub username may already be taken. Try another username; if this continues, contact support.");
                }
                throw error;
            }
            // Supabase can hide existing confirmed emails behind a fake
            // successful response with an empty identities array.
            if (Array.isArray(data?.user?.identities) && data.user.identities.length === 0) {
                rejectConflicts({ email_taken: true });
            }
            return data;
        },

        async login(email, password) {
            const { data, error } = await requireClient().auth.signInWithPassword({
                email: email.trim(), password,
            });
            if (error) throw error;
            return data;
        },

        async requestPasswordReset(email) {
            const normalizedEmail = validateEmail(email);
            const { error } = await requireClient().auth.resetPasswordForEmail(normalizedEmail, {
                redirectTo: redirects().recovery,
            });
            if (error) throw emailError(error);
        },

        async resendConfirmation(email) {
            const normalizedEmail = validateEmail(email);
            const { error } = await requireClient().auth.resend({
                type: 'signup', email: normalizedEmail,
                options: { emailRedirectTo: redirects().confirmation },
            });
            if (error) throw emailError(error);
        },

        async updatePassword(password) {
            if (password.length < 6) throw new Error("Password must contain at least 6 characters.");
            const { error } = await requireClient().auth.updateUser({ password });
            if (error) throw error;
        },

        async loadProfile(user) {
            const { data, error } = await requireClient()
                .from("profiles")
                .select("id, khub_username")
                .eq("id", user.id)
                .single();
            if (error || !data) {
                throw new Error("Your profile could not be loaded. Please sign out and sign in again. If this continues, contact support.");
            }
            return { id: data.id, khubUsername: data.khub_username, email: user.email };
        },
    };
}
