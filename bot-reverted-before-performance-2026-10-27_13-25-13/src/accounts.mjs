import { randomInt } from 'node:crypto';

export function generateTemporaryPassword() {
    // Keep the entire token below KMail's observed long-word splitting length.
    // Twelve uniformly random base62 characters supply about 71 random bits;
    // the fixed prefix satisfies mixed-case/digit/symbol password policies.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return 'Kh9!' + Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export async function processAccountMail(store, mail, { onReceiptRecorded = () => {} } = {}) {
    // The same secret is retained privately for a pending job. A replay never
    // generates another password change or another credential delivery.
    let job = await store.rpc('bot_prepare_account_mail', { p_mail: mail, p_password: generateTemporaryPassword() });
    // Only a confirmed preparation response establishes that any attached
    // assets are durably accounted for before isolating later account errors.
    onReceiptRecorded();
    if (job.state === 'done') return;
    job = await store.rpc('bot_check_account_job', { p_mail_id: mail.id });
    if (job.state === 'done') return;
    // The durable schedule also guards inbox replays and worker restarts.
    if (!await store.rpc('bot_begin_account_attempt', { p_mail_id: mail.id })) return;
    const user = await store.accountAdmin.get(job.user_id);
    if (user?.app_metadata?.khub_account_job !== job.mail_id) {
        if (job.action === 'register') {
            if (user) throw new Error('Registration identity conflict; operator review required.');
            await store.accountAdmin.create({ id: job.user_id, email: job.login_email,
                password: job.temporary_password, email_confirm: true,
                user_metadata: { khub_username: job.username }, app_metadata: { khub_account_job: job.mail_id } });
        } else {
            if (!user || user.email !== job.login_email) throw new Error('Recovery identity conflict; operator review required.');
            await store.accountAdmin.update(job.user_id, { password: job.temporary_password, email_confirm: true,
                app_metadata: { ...user.app_metadata, khub_account_job: job.mail_id } });
        }
    } else if (user.email !== job.login_email) throw new Error('Account identity conflict; operator review required.');
    await store.rpc('bot_finish_account_job', { p_mail_id: mail.id });
}
