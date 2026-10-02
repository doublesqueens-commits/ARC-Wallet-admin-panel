# ARC Wallet

## Run

- Dependencies: `npm install` (Node.js 24 is required for `node:sqlite`).
- Start the web app with `npm start`. The `Start application` Replit workflow serves it on port 5000.
- The user app is at `/`; the admin panel is at `/admin`; `/api/health` checks the server.
- The app uses the existing local `orbit.db` SQLite file and initializes missing tables on startup. Do not replace it with a different database without an explicit migration.

## Configuration

- `GOOGLE_CLIENT_ID`: Google OAuth 2.0 client ID for a Web application. See the Google sign-in setup below; the client ID is public, but the Google Cloud origin allowlist is managed outside this project.
- `JWT_SECRET`: optional long random value used to sign app sessions. On Replit, the existing `SESSION_SECRET` is used when this is omitted.
- `ADMIN_PASSWORD`: password for the ARC admin account (at least 12 characters for setup). Store in Replit Secrets, not in the repository.
- `ADMIN_EMAIL`: email of an existing ARC Wallet account to promote.
- `MAIL_FROM`: verified Resend sender, for example `ARC Wallet <login@example.com>`.
- Email is sent through the attached Replit Resend integration. `RESEND_API_KEY` is only a fallback for running outside Replit. The default sender is `ARC Wallet <onboarding@resend.dev>`; Resend's test sender may only deliver to the account owner's address. For general signups, verify a sending domain with Resend and set `MAIL_FROM` to an address on that domain.
- `OAUTH_REDIRECT_BASE`, X, and VK credentials are only required when enabling those providers.
- The imported `.env` file is ignored by Git but is loaded by the server for variables not already set in Replit. Keep credentials in Replit Secrets and do not share the `.env` file.

## Google sign-in setup

This app uses Google Identity Services (`google.accounts.id`) to receive an ID-token credential in the browser, then posts it to `/auth/google` for server verification. It does not use an OAuth redirect callback for Google sign-in, so do not add `/auth/google` or another app path as an Authorized redirect URI.

In Google Cloud Console, open **Google Auth Platform → Clients** and select the Web application client whose client ID is configured as `GOOGLE_CLIENT_ID`. Add each app origin under **Authorized JavaScript origins**. An origin is only the scheme, hostname, and optional port—do not include a path or trailing slash.

- Current Replit development origin: `https://fa829b42-0289-4a76-989b-7f8e1113c401-00-2bil7nf5zzlcx-b04gbgxv.sisko.replit.dev`. If Replit shows a different development hostname later, use that current HTTPS origin instead.
- Production: Replit deployment metadata currently returns no production URL for this workspace. Use the exact primary URL shown in Replit Publishing, plus any custom domains users will sign in from; if the app is already published, confirm that URL in Publishing. Do not guess or substitute the development hostname.
- For production, Google recommends keeping test-only origins off the production OAuth client. Use a separate Web application client for development and production, with the matching `GOOGLE_CLIENT_ID` configured in each environment.
- This app uses Google sign-in only; it does not request access to other Google APIs. Google classifies `openid`, `email`, and `profile` as basic identity scopes. An External app in Testing can still be accessed by accounts outside its test-user list when it requests only those scopes, but Google shows users a testing warning. Apps requesting other scopes may be restricted to listed test users while in Testing.
- Check the consent-screen state under **Google Auth Platform → Audience**; it is managed in Google Cloud and cannot be determined from this repository. For an External app in Published status, any Google account can access it. If the app needs verified name/logo branding or later requests sensitive or restricted scopes, complete the corresponding Google verification process; domain ownership may also need to be verified in Search Console.

Google requires domains used for OAuth to be owned or explicitly authorized, and production verification can require domain ownership verification. If Google Cloud rejects a Replit-managed hostname or requires verification that cannot be completed for it, use a domain you control for the sign-in test and production rather than claiming the shared Replit domain is verified. Google references: [Get a Google API client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) and [OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies).

## Admin setup

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters) in the environment; keep the password in Replit Secrets.
2. Run `npm run admin:setup` once in the Shell, or again if changing the admin email or password. It promotes an existing account or creates the admin account when missing.
3. Restart the `Start application` workflow after changing these values. Open `/admin` and sign in as `arcwallet@admin` (or with `ADMIN_EMAIL`) using `ADMIN_PASSWORD`.

The initial admin setup has been run in this Replit. User login and registration require an emailed one-time code. Google sign-in also requires the app's development and published origins to be allowed on its Google OAuth client; X and VK need their own credentials and callback configuration. Wallet balances and receiving addresses in this project are demonstration data, not live custodial wallet accounts.