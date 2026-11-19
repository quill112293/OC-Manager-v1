# OC Manager V1

A standalone, mobile-friendly Torn faction portal. Members use one personal key to open My Profile. Recruiting, My OCs and View History are the member tabs. Approved staff can browse faction-wide active OCs and OC History. Both history screens have delay and success filters. A delayed success appears under both filters.

The welcome screen shows the configured faction’s Torn banner above the personal key field. The Worker reads the faction name and banner from Torn’s public `faction/basic` selection using the server key, verifies the faction ID, and refreshes them hourly when visitors open the welcome screen. If using a custom server key, include this selection. Sign-in is available while the artwork loads.

## Review the layout

Open [review.html](./review.html) in a browser to view the welcome layout. The sign-in link opens the deployed portal.

## Run the Worker

1. Use a Cloudflare D1 database for this faction. Put its ID in wrangler.jsonc, then apply the schema with `npx wrangler d1 execute oc-manager --remote --file schema.sql`. Use a separate Worker for V1 while reviewing the new portal.
2. The production configuration includes WIT-Horizon's faction ID and the owner's numeric player ID. Set `TORN_KEY` with `npx wrangler secret put TORN_KEY` using a dedicated faction-authorized key that can read key info, faction members and faction crimes. Do not commit keys or database exports.
3. The owner signs in with a separate personal OC Manager key. To pair or replace it, enter it on the welcome screen. After Torn verifies the owner, choose **Copy fingerprint**. In the Worker's **Settings → Variables and Secrets**, set the secret `OWNER_KEY_SHA256` to this fingerprint and deploy. Sign in again with the same personal key. Members use a dedicated key that permits key/info. The site confirms current membership against the faction roster. The first valid login enrolls that key fingerprint for future logins.
4. Deploy using `npx wrangler deploy`. The five-minute trigger starts collecting active and completed records. On a new database the first completed-crime window covers the preceding day. Historical travel and item observations begin with collection. The same database schema can read earlier oc_records rows, with missing fields shown as unverified.
5. Open the Worker URL in any browser. A Torn script is optional. For a shortcut from Torn’s faction page, install `/oc-manager.user.js` from your own Worker URL with your userscript manager. The shortcut opens your portal and receives no keys.

The member key is used only to verify identity and faction during sign-in. The Worker stores the enrolled key fingerprint, player profile and a hashed, revocable session token. The raw personal key is discarded. Member data is read through the session, staff requests are checked server-side, and membership is refreshed from Torn at most five minutes apart. To reset a member’s enrollment after key replacement, the operator removes that member’s portal sessions, staff grant and profile before trusted re-enrollment. The owner has a separately pinned key.

## Data in V1

If the tracker secret is missing, members can still sign in and view saved records. When the five-minute roster cache expires, the next sign-in uses the member's personal key to verify the configured faction's public roster. Until that check succeeds, open sessions must verify membership again to load data. Scheduled OC collection resumes once the tracker secret is restored.

Scheduled-to-executed delay is divided into per-member intervals, observed time awaiting execution and unverified time. Overlapping recorded events keep their first blocker until that blocker clears. Simultaneous causes with no established first blocker stay open for review. Snapshot intervals are estimates. The manager never attributes gaps in observations to a player.

Levels 1–2 have no entry requirements. For level 3 and up, a role qualifies with at least 60 CPR or a role weight of 7% or less. Recruiting, active and historical OCs display per-role influence estimates from the bundled [Torn Probability role-weight dataset](https://tornprobability.com:3000/api/GetRoleWeights). Unknown or ambiguous roles are marked unknown. Eligibility comparisons use the underlying percentages before display rounding. The join link opens Torn’s OC page; the user selects the role in Torn. Armoury transfers, reimbursements, alerts and penalty actions are deferred.

## Development

Run `npm test` with Node 24 or newer. Run `npm run preview` to regenerate the offline review from the same UI assets as the Worker.
