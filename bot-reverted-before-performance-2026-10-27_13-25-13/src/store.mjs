import { createClient } from '@supabase/supabase-js';
// Auth responses can contain user-supplied values. Only expose bounded status/code,
// never raw messages, request bodies, headers, passwords or user records.
export function authAdminFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'unknown_error';
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? `HTTP ${error.status}; ` : '';
    return new Error(`Auth ${operation} was not confirmed (${status}${code}); request retained for retry.`);
}

const accountRpcs = new Set(['bot_prepare_account_mail', 'bot_check_account_job', 'bot_finish_account_job', 'bot_pending_account_requests', 'bot_notify_account_failure', 'bot_begin_account_attempt']);

export function createStore(url, key, { accountTimeoutMs = 20000 } = {}) {
    if (!url || !key) throw new Error('Set server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in bot/.env.');
    if (!Number.isSafeInteger(accountTimeoutMs) || accountTimeoutMs <= 0) throw new Error('Invalid account request timeout.');
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    // Bound account-service hangs without changing financial RPC/send timeouts.
    // A lost Auth response is recovered through the existing fixed ID/job stamp.
    const accountClient = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init = {}) => fetch(input, { ...init,
            signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(accountTimeoutMs)]) : AbortSignal.timeout(accountTimeoutMs),
        }) },
    });
    return {
        accountAdmin: {
            async get(id) {
                const { data, error } = await accountClient.auth.admin.getUserById(id);
                if (error?.code === 'user_not_found') return null;
                if (error) throw authAdminFailure('account lookup', error);
                return data.user;
            },
            async create(attributes) {
                const { error } = await accountClient.auth.admin.createUser(attributes);
                if (error) throw authAdminFailure('account creation', error);
            },
            async update(id, attributes) {
                const { error } = await accountClient.auth.admin.updateUserById(id, attributes);
                if (error) throw authAdminFailure('password update', error);
            },
        },
        async rpc(name, params = {}, { signal } = {}) {
            const request = client.rpc(name, params);
            if (signal) request.abortSignal(signal);
            if (accountRpcs.has(name)) request.abortSignal(AbortSignal.timeout(accountTimeoutMs));
            const { data, error } = await request;
            // Never log request headers, keys, or session cookies.
            if (error) {
                const failure = new Error(`${name}: ${error.message}`);
                failure.code = error.code;
                throw failure;
            }
            return data;
        },
    };
}
