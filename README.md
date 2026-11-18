# OC Manager V1

A standalone, mobile-friendly Torn faction portal. Members use one personal key to open My Profile. Recruiting, My OCs and View History are the member tabs. Approved staff can browse faction-wide active OCs and OC History. Both history screens have delay and success filters. A delayed success appears under both filters.

The welcome screen shows the configured faction’s Torn banner above the personal key field. The Worker reads the faction name and banner from Torn’s public `faction/basic` selection using the server key, verifies the faction ID, and refreshes them hourly when visitors open the welcome screen. If using a custom server key, include this selection. Sign-in is available while the artwork loads.

## Review the layout

Open [review.html](./review.html) in a browser to view the welcome layout. The sign-in link opens the deployed portal.

## Run the Worker

1. Use a Cloudflare D1 database for this faction. Put its ID in wrangler.jsonc, then apply the schema with `npx wrangler d1 execute oc-manager --remote --file schema.sql`. Use a separate Worker for V1 while reviewing the new portal.
2. Set `FACTION_ID` and `OWNER_ID` to the numeric faction and owner player IDs. Set `TORN_KEY` with `npx wrangler secret put TORN_KEY` using a dedicated faction-authorized key that can read key info, faction members and faction crimes. Do not commit keys or database exports.
3. The owner signs in with a separate personal OC Manager key. To pair or replace it, enter it on the welcome screen. After Torn verifies the owner, choose **Copy fingerprint**. In the Worker's **Settings → Variables and Secrets**, set the secret `OWNER_KEY_SHA256` to this fingerprint and deploy. Sign in again with the same personal key. Members use a dedicated key that permits key/info. The site confirms current membership against the faction roster. The first valid login enrolls that key fingerprint for future logins.
4. Deploy using `npx wrangler deploy`. The five-minute trigger starts collecting active and completed records. On a new database the first completed-crime window covers the preceding day. Historical travel and item observations begin with collection. The same database schema can read earlier oc_records rows, with missing fields shown as unverified.
5. Open the Worker URL in any browser. A Torn script is optional. For a shortcut from Torn’s faction page, install `/oc-manager.user.js` from your own Worker URL with your userscript manager. The shortcut opens your portal and receives no keys.

The member key is used only to verify identity and faction during sign-in. The Worker stores the enrolled key fingerprint, player profile and a hashed, revocable session token. The raw personal key is discarded. Member data is read through the session, staff requests are checked server-side, and membership is refreshed from Torn at most five minutes apart. To reset a member’s enrollment after key replacement, the operator removes that member’s portal sessions, staff grant and profile before trusted re-enrollment. The owner has a separately pinned key.

## Data in V1

Scheduled-to-executed delay is divided into per-member intervals, observed time awaiting execution and unverified time. Overlapping recorded events keep their first blocker until that blocker clears. Simultaneous causes with no established first blocker stay open for review. Snapshot intervals are estimates. The manager never attributes gaps in observations to a player.

Levels 1 and 2 have unrestricted CPR and weight. For higher levels the faction uses at least 60 CPR and at most 7% weight. In the live recruiting view an opening without verified member-specific values says **Verify in Torn**. The join link opens Torn’s OC page; the user selects the role in Torn. Armoury transfers, reimbursements, alerts and penalty actions are deferred.

## Development

Run `npm test` with Node 24 or newer. Run `npm run preview` to regenerate the offline review from the same UI assets as the Worker.
