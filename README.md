# Château Douma Loyalty Club

## Quick start (new GitHub + new Netlify)
1. **Create a GitHub repository.** At **github.com**, create an account, then click **+ → New repository**. Name it `chateau-douma-club`, choose **Private**, and leave everything else off. Click **Create repository**.
2. **Upload the files.** Click **uploading an existing file**, unzip this package, open the folder, press **⌘A**, drag everything in and click **Commit changes**. There are no folders, so nothing gets lost.
3. **Create the Netlify app.** At **app.netlify.com**, sign up with GitHub, then choose **Import from Git → GitHub → chateau-douma-club** and click **Deploy**. Don't type anything in the build settings, and don't use the "agent / Claude Code" box, because it costs credits.
4. **Add the keys.** Use **Find a setting → "environment" (Keys and secrets) → Add**. Tick **Contains secret values** for both:
   - `OWNER_PIN` with **numbers only**, 4–10 digits, e.g. `482913`. The name has an underscore.
   - `SESSION_SECRET` with any long random text.
5. **Make it public.** Go to **Manage → Who can see it → Public** and save.
6. **Publish.** Click **Publish** and wait until it says **Live**. The PIN only works after this.
7. **Open the apps.** Customers use `https://YOUR-APP.netlify.app/join`. You and staff use `https://YOUR-APP.netlify.app/staff` and sign in with the owner PIN. Then go to **Staff → Add staff member** to give each person their own PIN.

**Saving credits:** the free plan has 300 credits a month, and every upload or Publish costs 15. Put all changed files into one upload. Settings, levels, rewards, campaigns and staff are changed inside the owner app at no cost.

--- 

The project has three apps, all on one Netlify site:

| Who | Address | What it does |
|---|---|---|
| Customers | `/join` → `/card` (existing members tap **I'm already a member** to sign in on a new phone) | Sign up, then use a wallet card in the colour of their level (Light red / Silver / Gold). The available cashback is shown large, with a QR code, progress to the next level, transactions, rewards, profile and messages. Customers can add it to the Home Screen, and to Apple Wallet or Google Wallet once you set those up. |
| Staff | `/staff` | Each person signs in with their own PIN. Staff scan a member's QR code (or search by name, number, phone or email), then use **Add purchase**: invoice, reference, category, cashback to redeem, then a confirmation screen. They also handle free stamp drinks and phone verification. |
| Owner | `/staff` with the **owner PIN** | Everything staff can do, plus Dashboard, Customers, Transactions, Campaigns, Analytics, Staff (with the audit log) and Settings. |

## Upload and go live

1. **Create a new private GitHub repository**, for example `chateau-douma-club`.
2. Click **uploading an existing file**, unzip the package, select **all files** (⌘A), drag them into the page and click **Commit changes**. There are no folders, so nothing gets lost.
3. On **app.netlify.com**, go to **Add new site → Import an existing project → GitHub** and choose the repository. Click **Deploy**; the settings come from `netlify.toml`.
4. In **Site configuration → Environment variables**, add:

| Key | Required? | Value |
|---|---|---|
| `OWNER_PIN` | **Yes** | Your private PIN (6+ digits). Only you should know it. |
| `STAFF_PIN` | Optional | A shared team PIN. It's better to give each person their own PIN under **Staff** in the app, then delete this one. |
| `SESSION_SECRET` | Recommended | Any long random text (40+ characters). It keeps sign-ins secure. |

5. Go to **Deploys → Trigger deploy**. Open `/staff`, sign in with the owner PIN, go to **Staff** and add each team member with their own PIN.
6. Go to **Campaigns → Join QR poster**, print it and place it at the bar and on the tables.

> **Already using the first version on the same Netlify site?** Existing members are upgraded automatically the first time their card or record is opened. Member numbers, names, phones and stamp cards are kept, and nothing is overwritten. A new site starts empty.

## The rules (all can be changed in **Settings**, no code needed)

- **Levels:** CLASSIC MEMBER 5% (from day one), SEMI-PREMIUM MEMBER 7.5% (from $250 lifetime eligible spending), PREMIUM MEMBER 10% (from $750).
  - Upgrades are automatic and apply from the **next** purchase.
  - Levels never expire. Only the owner can lower a level. The one exception: if a refund takes away the spending that earned a level, the level is taken back too. This stops people from buying, getting upgraded and then refunding.
- **Cashback** is store credit in USD.
  - It is earned on the eligible amount **actually paid**: after discounts, and not on the part paid with cashback.
  - It can be used from the next visit, never in the same transaction.
  - It expires after 12 months, and members get a reminder 30 days before.
  - The oldest cashback is used first.
- **Welcome reward:** $2, given once per phone number.
  - It is locked until the phone is verified (staff send a code by WhatsApp from the member screen and the customer reads it back).
  - It also needs the first paid purchase before it unlocks.
  - It doesn't count towards level spending.
- **Birthday reward:** $5 once a year on the member's birthday, valid for 30 days. Customers can save their date of birth only once; after that, only the owner can correct it, and every change is logged.
- **Campaigns:** a multiplier (e.g. 2×) or a fixed percentage.
  - Each campaign can be limited to certain levels and categories, with a maximum bonus per purchase and per customer.
  - Campaigns switch on and off automatically by Beirut time.
  - They don't stack unless you allow it.
- **Refunds:** full or partial.
  - The cashback earned on the refunded part is removed, and cashback that was used on it is returned to the wallet.
  - If the earned cashback was already spent, its value is taken off the cash refund. The app shows staff the exact amount to give back.
- **Records:** nothing is ever deleted.
  - Corrections are new reversal entries.
  - Every manual change needs a reason and is written to the **audit log** with who did it and when.
- **Duplicates:** each invoice reference can only be used once. Pressing Confirm twice saves only one purchase.

## Optional connections

### Apple Wallet (needs an Apple Developer account, which Apple charges for yearly)
1. At developer.apple.com, go to **Certificates, IDs & Profiles → Identifiers → Pass Type IDs** and create one, e.g. `pass.com.chateaudouma.loyalty`.
2. Create a **Pass Type ID Certificate** for it, open it in Keychain on a Mac and export it as `pass.p12`.
3. Download Apple's **WWDR G4** certificate (`AppleWWDRCAG4.cer`).
4. In Terminal:
   ```
   openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass-cert.pem -legacy
   openssl pkcs12 -in pass.p12 -nocerts -nodes -out pass-key.pem -legacy
   openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
   base64 -i pass-cert.pem | pbcopy   # paste into APPLE_PASS_CERT
   base64 -i pass-key.pem  | pbcopy   # paste into APPLE_PASS_KEY
   base64 -i wwdr.pem      | pbcopy   # paste into APPLE_WWDR_CERT
   ```
5. In Netlify, add `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID` (10 characters, shown on your Apple account), `APPLE_PASS_CERT`, `APPLE_PASS_KEY` and `APPLE_WWDR_CERT`, then redeploy.

Once that's done, customers see **Add to Apple Wallet** in My Wallet. The pass uses the colour of their level, shows the balance, level, rate, QR code, member since and last visit, and updates itself when the balance or level changes.

### Google Wallet (free)
1. At **pay.google.com/business/console**, open **Google Wallet API** and note your **Issuer ID**.
2. In Google Cloud Console, create a project, enable the **Google Wallet API**, then create a **service account** and download its **JSON key**.
3. Back in the Wallet console, go to **Users** and add the service account's email address as a Developer.
4. Run `base64 -i key.json | pbcopy` and paste the result into `GOOGLE_WALLET_SERVICE_ACCOUNT`. Add `GOOGLE_WALLET_ISSUER_ID`, then redeploy.
5. Google keeps new issuers in *demo mode*, where only test accounts can save passes. Request publishing access in the console to make it work for all customers.

### Phone notifications
These work with no setup. On iPhone, the customer must add the card to their Home Screen and allow notifications. Every message also appears in the inbox on the card.

## Signing in on a new phone
Members don't need a password.
1. On the join page, the member taps **I'm already a member** and enters their phone number. A 6-digit code appears on their screen.
2. A staff member opens that member, checks it is really them and types the code under **Sign-in request**.
3. The card opens on the customer's phone automatically.

If the customer isn't at Château Douma, staff can tap **Send card link (WhatsApp)** on the member's screen instead.

## Data storage

Data is stored in **Netlify Blobs**, which is included free with Netlify.
- **Member records:** each member is one record holding a permanent **ledger** of every transaction and the cashback "lots", each with its own expiry date. The balance is always worked out from the ledger, never typed in.
- **Atomic changes:** every change is a single all-or-nothing write that is checked against simultaneous edits. Two tills can't redeem the same cashback twice, and a failed transaction changes nothing.
- **Reports** use a separate monthly event log. **Settings → Rebuild reports** recreates it from the ledgers at any time.
- **Schema upgrade:** v1 records (stamps only) are converted to v2 the first time they are read. Nothing is lost.

## Try it on a computer (developers)
```
npm install
npm test            # 43 automated checks: purchases at every level, redemptions, refunds, expiry, birthdays, campaigns, permissions, duplicates, wallet passes
node dev-server.mjs # http://localhost:8888/join and /staff (owner PIN 999999, staff PIN 1234). Data is kept in memory only.
```

## Files
- **Pages:**
  - `join.html` is sign-up.
  - `card.html` is the customer app.
  - `staff.html` is the owner and staff app.
  - `m.html` is the page a stranger sees if they scan someone's QR code; it shows no personal data.
  - `style.css` is the shared styling, and `terms.js` builds the programme terms from your live settings.
- **Server:**
  - `core.mjs` is the API, `engine.mjs` holds all the cashback rules, and `wallet.mjs` handles Apple and Google Wallet.
  - `util.mjs` and `store-netlify.mjs` are helpers.
  - `api.mjs` and `daily.mjs` are the Netlify function entry points. `daily.mjs` runs every morning to handle expiries, warnings and birthdays.
- **Images:** the logo, app icons and wallet images in the tier colours. `pass-assets.mjs` holds the Apple pass images.
