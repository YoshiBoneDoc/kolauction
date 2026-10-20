> **Current registration:** send `REGISTER` by normal KMail to kHub (#3888760),
> with no attachments. Your username is your verified KoL character name;
> custom usernames are not allowed. `CREDENTIALS` requests a fresh password.
> New accounts need no SMTP. See [current account setup](README.md#current-account-setup-kmail-registration).
> The email setup instructions below describe the previous email-based flow.

# Account email and recovery setup

Implementation date: October 19, 2026.

## What is implemented

- `/forgot-password`: requests a password reset email.
- `/reset-password`: accepts a valid recovery session and updates the password.
- `/resend-confirmation`: requests another signup confirmation email.
- `/auth/confirm`: displays confirmation results or invalid/expired-link guidance.
- Login and registration include links to these flows.
- Successful email requests have a 60-second UI cooldown. Supabase/provider
  rate limits still apply, including across tabs and page reloads.
- Errors are displayed rather than showing a false email-sent success message.
- Recovery and resend requests use neutral success messages when no eligible
  account exists. They do not call the registration-availability function.

No new SQL migration is needed for these features. Supabase Auth supplies the
email and password APIs. The existing registration migration is still required
for normal duplicate-account checks.

## SMTP explained and current blocker

SMTP is the connection Supabase uses to ask an email provider to deliver signup
and password reset messages. It is configured in the Supabase dashboard, not
inside React.

Supabase's built-in email sender is intended for testing. As of the documentation
check above, it sends only to addresses belonging to the project's organization
team and permits two messages per hour. It is not a public-user email service.

Requested sender: `kHub_Bot@proton.me`. Proton's hosted SMTP submission is available
on paid Proton Mail plans for **custom-domain addresses**. The `@proton.me`
mailbox cannot be selected as a custom-domain SMTP sender. Knowing its mailbox
password is not sufficient, and that password should not be used for SMTP.

To proceed, choose a supported sending address/provider. One option is a custom
domain address in Proton on an eligible plan. Alternatively use a transactional
email provider with a verified sending domain. The Proton mailbox can remain a
separate inbox; it has not been configured as a sender or reply-to by this change.

Sources:

- https://supabase.com/docs/guides/auth/auth-smtp
- https://proton.me/support/smtp-submission

## Supabase email settings

1. Set up and verify the sending domain/address with your chosen provider.
   Add the exact DNS authentication records the provider supplies (SPF/DKIM,
   and an appropriate DMARC policy). Do not guess record values.
2. In Supabase Authentication, open the SMTP settings and enable custom SMTP.
3. Enter the provider's SMTP host, port, username, and SMTP password/token.
   Set the sender email to that provider's verified address and sender name
   to `KoL Auction Hub`.
4. Store SMTP credentials only in Supabase's SMTP settings. Never add them to
   `VITE_` environment variables, browser code, or version control.
5. Review Supabase Auth email rate limits and your provider's limits. Enabling
   custom SMTP does not make sending unlimited.
6. Verify real signup, resend, and recovery deliveries before inviting users.

If using Proton with a supported custom-domain address, its documented host is
`smtp.protonmail.ch`, port `587`, using STARTTLS. Generate an SMTP token in Proton
Settings → All settings → IMAP/SMTP → SMTP tokens for that custom-domain address.
Use that address as the SMTP username and the generated token as its password.
Do not use your Proton login or mailbox password.

This repository change has not configured hosted SMTP: a supported sender,
provider credentials, and dashboard access are still required.

## Redirect URLs for local development and production

In Supabase Authentication → URL Configuration, allow these exact local URLs:

```text
http://localhost:5173/auth/confirm
http://localhost:5173/reset-password
```

If you actually use a different port or `127.0.0.1`, add those exact addresses
as well. Hostnames and ports must match the URL in your browser.

Before deployment, add the corresponding exact production URLs, replacing the
placeholder with your real HTTPS hostname:

```text
https://YOUR_DEPLOYED_HOST/auth/confirm
https://YOUR_DEPLOYED_HOST/reset-password
```

While developing, Site URL can be `http://localhost:5173`. When deploying, change
Site URL to your production root, for example `https://YOUR_DEPLOYED_HOST`.
Keep the local callback URLs in the allowlist if you still use local development.

The code uses the browser's current origin for each email request. It does not
hardcode localhost into deployed links, trust an arbitrary `next`/redirect query
parameter, or require a second frontend URL environment variable. A link requested
locally points locally; one requested on the production site points to that site.
Supabase must allow each callback URL or it may fall back to Site URL.

Because this is a Vite single-page app, configure production hosting to serve
`index.html` for `/auth/confirm` and `/reset-password` (and the other application
routes). The exact rewrite setting depends on the hosting provider. Test by
opening each path directly, not just navigating from the homepage.

Source: https://supabase.com/docs/guides/auth/redirect-urls

## Email templates

In Supabase Authentication's email templates, copy:

- `email-templates/confirm-signup.html` into Confirm signup.
- `email-templates/reset-password.html` into Reset password.

Both use `{{ .ConfirmationURL }}`. That URL first validates the one-time token
with Supabase and then redirects to the app. Keep that full verification URL;
do not replace it with only `{{ .SiteURL }}` or `{{ .RedirectTo }}`, which would
navigate to the app without validating the email token.

This app uses Supabase's browser implicit flow. Supabase verifies the link;
the SDK consumes the returned session fragment. No custom token-hash endpoint,
server-side SDK, or Next.js middleware is needed for this Vite application.

## Manual verification after dashboard setup

Use a test account and mailbox you control. Allow time between requests to
respect the configured email limits.

1. Register from localhost. Open the confirmation email and verify the browser
   returns to `http://localhost:5173/auth/confirm` and shows a confirmed account.
2. With a separate unconfirmed test signup, use Resend confirmation. Open the
   newest email and verify the same callback path.
3. Log out. From Forgot password, request recovery. Open the email, verify it
   lands at `/reset-password`, and set a new password twice in the form.
4. Log out after success and verify the old password fails and the new one works.
5. Open `/reset-password` directly while logged out and while ordinarily signed
   in: neither should show the recovery form without a recovery session.
6. Refresh the reset page before submitting: the valid recovery session should
   remain usable in that browser tab. A signout or account switch clears it.
7. Try an expired or already-used email link. It must show actionable guidance,
   not report a successful confirmation or let an unrelated existing session
   authorize the password reset.
8. Repeat signup, resend, recovery, and direct callback-path visits on the real
   deployed HTTPS URL. Verify production requests never send users to localhost.
9. Verify the delivered From address, inbox/spam behavior, and provider logs.

## Verification status

Automated tests cover local and HTTPS URL generation, request parameters, error
handling, recovery session transitions, and rendered pages/routes. The build and
changed-file lint checks are also run. This is not proof of mailbox delivery.
Real SMTP delivery, dashboard URL allowlisting, and deployed-link verification
remain pending until the sender and deployment are configured.

The Info page was not edited for this feature.
