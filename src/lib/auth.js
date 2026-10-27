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

    return {
        async register() {
            throw new Error("Register through kHub KMail. Send REGISTER from the KoL account you want to link.");
        },

        async login(identifier, password, { appeal = false } = {}) {
            const api = requireClient();
            const value = identifier.trim();
            let email = value;
            if (/^KH_/i.test(value) || !value.includes('@')) {
                if (!/^KH_.+/i.test(value)) throw new Error("Use your kHub username: KH_ followed by your KoL name.");
                const resolved = await api.rpc(appeal ? 'khub_appeal_login_address' : 'khub_login_address', { p_username: value });
                if (resolved.error) throw new Error("Username login is temporarily unavailable. Please try again later.");
                if (!resolved.data) throw new Error("Invalid username or password.");
                email = resolved.data;
            }
            const { data, error } = await api.auth.signInWithPassword({ email: email.toLowerCase(), password });
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
            if (password.length < 12) throw new Error("Password must contain at least 12 characters.");
            const { error } = await requireClient().auth.updateUser({ password });
            if (error) throw error;
        },

        async loadProfile(user) {
            const { data, error } = await requireClient().rpc('read_my_account_access');
            if (error || !data || data.id !== user.id || typeof data.is_banned !== 'boolean'
                || !Number.isFinite(Date.parse(data.server_now))
                || (data.ban_expires_at != null && !Number.isFinite(Date.parse(data.ban_expires_at)))) {
                throw new Error("Your profile could not be loaded. Please sign out and sign in again. If this continues, contact support.");
            }
            return { id: data.id, khubUsername: data.khub_username, email: data.account_method === 'kmail' ? null : user.email,
                accountMethod: data.account_method, isBanned: data.is_banned, banExpiresAt: data.ban_expires_at || null,
                serverOffset: Date.parse(data.server_now) - Date.now() };

        },
    };
}
