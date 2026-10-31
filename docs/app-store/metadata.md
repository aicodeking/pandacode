# App Store metadata: PandaCode for iPhone 1.0

Copy each block into App Store Connect as is. Counts are Unicode characters, the way App Store
Connect counts them, and were checked with a script (`len()` on the text between the fences).

Everything below must stay true of the app. If a feature changes, change this file with it.

The website (`website/`, Worker `pandacode-site-bambooed`) is served at
https://pandacode.bambooed.ai ([SUBMITTING.md](SUBMITTING.md#0-set-your-domain-done)). The pages must be live before you submit:
App Review opens the privacy policy and support URLs.

## App Information (App Store Connect → your app → General → App Information)

### Name (30 max) — 9

```
PandaCode
```

If the name is taken, use `PandaCode Connect` (17).

### Subtitle (30 max) — 28

```
Your coding agents, anywhere
```

### Category

- Primary: **Developer Tools**
- Secondary: **Productivity**

### Content rights

"Does your app contain, show, or access third-party content?" → **No**. The app shows only the
user's own tasks from the user's own computers.

### Age rating (App Information → Age Rating → Edit)

Answer every content question **None** / **No**:

| Question | Answer |
|---|---|
| Cartoon or fantasy violence | None |
| Realistic violence | None |
| Prolonged graphic or sadistic realistic violence | None |
| Profanity or crude humor | None |
| Mature or suggestive themes | None |
| Horror or fear themes | None |
| Medical or treatment information | None |
| Alcohol, tobacco, or drug use or references | None |
| Simulated gambling | None |
| Sexual content or nudity | None |
| Graphic sexual content and nudity | None |
| Contests | None |
| Unrestricted web access | **No** (the app has no web browser; links open in the system browser) |
| Gambling | No |
| User-generated content / messaging with other users | **No** (a user talks only to their own computers and agents; there are no other users to reach) |
| Advertising | No |
| Parental controls | No |
| Age assurance | No |

Expected result: **4+**. If the questionnaire version you see asks about AI-generated content or
chatbots, answer **Yes** only if it asks whether the app *shows* generated text: it shows replies
from the user's own coding agents. That can raise the rating; accept what it gives.

## Version page (App Store Connect → your app → iOS App → 1.0 Prepare for Submission)

### Promotional text (170 max) — 142

```
Follow the coding agents on your computers from your phone. Read each turn as it streams, answer approvals and questions, and start new tasks.
```

### Description (4000 max) — 1,729

```
PandaCode for iPhone is a remote for the PandaCode desktop app.

Your coding agents keep working on your computer. This app lets you see what they are doing and answer them when you are away from your desk.

What you can do:

- See every task on every computer in one inbox.
- Read each turn as it streams in.
- Approve or deny a tool call when an agent asks.
- Answer an agent's questions.
- Send a follow-up, or steer a running turn.
- Stop a run.
- Change the model, reasoning effort and permissions of a task.
- Start a new task in any project on a computer you choose.

Messages you write while offline wait on the phone and go out in order when you reconnect.

What it does not do:

The app never runs code. It never downloads code. All work happens on your computer, with the agents and the permissions you set there. The phone sends your requests and shows the results.

Private by design:

PandaCode Connect carries your messages end to end encrypted. The relay that links your devices sees only device ids and ciphertext. It keeps your GitHub account id and the names and public keys of your devices, so they can find each other. Nothing else.

There are no ads, no analytics and no tracking. You can delete your account in Settings at any time.

What you need:

- The PandaCode desktop app (free, for macOS, Windows and Linux).
- A GitHub account. You sign in with the same account on the phone and on the computer.
- Allow remote control turned on in the desktop app's Settings → Remote access.

PandaCode is free and open source. The source of the desktop app, this app and the relay is on GitHub.

Want to look first? Tap Explore the demo on the sign-in screen. It shows sample computers and tasks, with no account.
```

### Keywords (100 max, comma-separated, no spaces) — 98

```
agent,coding,AI,developer,remote,control,approve,programming,devtools,code,monitor,tasks,companion
```

No trademarks of other companies (2.3.7) and no words already in the name or subtitle, which
are indexed anyway.

### URLs

| Field | Value |
|---|---|
| Support URL | `https://pandacode.bambooed.ai/support/` |
| Marketing URL (optional) | `https://pandacode.bambooed.ai/` |
| Privacy Policy URL (App Privacy page) | `https://pandacode.bambooed.ai/privacy/` |

### Copyright

```
2026 PandaCode contributors
```

(App Store Connect adds the © sign. This matches `LICENSE`.)

### What's New in This Version (1.0) (4000 max) — 180

App Store Connect hides this field for the first version. Keep it for TestFlight's "What to
Test" and for 1.0.1:

```
The first release of PandaCode for iPhone. See and answer the coding agents on your computers: one inbox for every task, live turns, approvals, questions, follow-ups and new tasks.
```

### App Review Information

- Sign-in required: **No**. Leave username and password empty: the app has a demo with no
  account (below). GitHub's device flow can't be done with a shared password anyway.
- Contact: first name, last name, phone and email of the person who submits. Use a phone that
  answers during review.
- Notes (4000 max; 1,602 before you fill in the contact line):

```
PandaCode for iPhone is a remote control for the PandaCode desktop app (free and open source, https://github.com/aicodeking/pandacode). It never runs or downloads code. All work runs on the user's own computer.

HOW TO REVIEW WITHOUT AN ACCOUNT
1. Open the app. On the sign-in screen, tap "Explore the demo".
2. The demo shows sample computers and tasks. It makes no network requests.
3. Inbox: every task across the computers. Tap a task to read its turns.
4. In a task: answer an approval or a question, send a follow-up, stop a run, or open Model & permissions from the toolbar.
5. New task (+): choose a computer and project and send a prompt.
6. Settings: appearance and wallpaper. Tap "Leave demo" there to return to sign-in. Signed in, Settings also has "Delete account".

REAL SETUP
A real setup needs the PandaCode desktop app on a Mac, Windows or Linux computer, signed in to PandaCode Connect with the same GitHub account as the phone, with "Allow remote control" on. The phone then lists that computer's tasks. We can set up a live computer for a call on request.

SIGN-IN
Sign-in is GitHub's device flow with no scopes: identity only. The account is the same GitHub identity the user's desktop app signs in with; the app has no accounts of its own. Settings > Delete account removes the account and every device from the relay.

ENCRYPTION
Messages between the phone and the computer are end-to-end encrypted with standard algorithms (X25519, XChaCha20-Poly1305). The relay forwards only ciphertext.

CONTACT
<name>, <email>, <phone>. Issues: https://github.com/aicodeking/pandacode/issues
```

## App Privacy (App Store Connect → your app → App Privacy)

Privacy Policy URL: `https://pandacode.bambooed.ai/privacy/`.

"Do you or your third-party partners collect data from this app?" → **Yes**.

What leaves the phone and is kept, checked against `relay/src/`:

| Data | Where | Kept |
|---|---|---|
| GitHub numeric user id | relay | Yes: it names the account (`gh:<id>`) |
| GitHub login and avatar URL | relay at sign-in, returned to the phone, shown in Settings | The relay reads them from GitHub at sign-in and returns them; the phone keeps them |
| Device ids (random, made by the app), device names, platforms, public keys, last seen | relay | Yes, one row per device, until you remove the device or delete the account |
| IP address | relay host (Cloudflare) | Rate limiting of sign-in, standard request logs |
| Message content (tasks, prompts, replies, approvals) | passes through the relay | No. End to end encrypted; the relay can't read it and doesn't store it |

Declare these types. For **each one** answer: used for **App Functionality** only; **Linked to
the user: Yes**; **Used for tracking: No**.

| Category → type | Why |
|---|---|
| Identifiers → **User ID** | GitHub numeric id and login, the account key |
| Identifiers → **Device ID** | The app-generated device id the relay keys each device by |
| Other Data → **Other Data Types** | Device names, platforms and public keys, avatar URL |

Do not declare: Contact Info (no email is requested or stored: the sign-in has no scopes),
Location, Health, Financial, Contacts, Browsing or Search History, Usage Data, Diagnostics
(no analytics, no crash reports), Purchases, Sensitive Info.

User Content: message content is end-to-end encrypted and never readable by the relay or by
us, so we don't declare it. If App Review asks, declare **Other User Content**, App
Functionality, linked, not tracking: over-declaring is allowed, under-declaring is not.

Result on the product page: **Data Linked to You: Identifiers, Other Data. Data Used to Track
You: none.**

## Pricing and Availability

- Price: **Free** (USD 0, tier Free). No in-app purchases.
- Availability: all countries, unless you answer the France question in export compliance
  ([SUBMITTING.md](SUBMITTING.md#export-compliance)) by leaving France out.
- Devices: iPhone only (`supportsTablet: false`); see [screenshots.md](screenshots.md).
