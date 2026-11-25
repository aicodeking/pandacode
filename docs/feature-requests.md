# Feature requests

An agent that notices PandaCode is missing something can leave a card above the prompt
(`pandacode_suggest_feature`, title and description). The user decides; nothing is sent
anywhere by the app.

## What you see

- **The card** (`src/feature-requests.ts`, `src/feature-requests.css`): "Suggested feature request",
  the agent's title and text (three lines, then Show more), and a line saying that Send request
  opens a draft on GitHub which you submit there. It sits in `#feature-requests`, directly above
  `#approval-bar` in the composer area, and takes no height when there is no card.
- **Send request** opens `issueUrl(title, description)` through `open_external_url`: GitHub's
  `feature_request.yml` form with the title and "What problem would this solve?" filled in and
  the proposal left to the user. The URL is cut at 7,000 characters (whole characters, ending in
  an ellipsis; the toast says the description was shortened). The card goes away. If the browser
  does not open, a toast offers Copy text and the card stays.
- **Do it myself** creates a pending task with `create_board_task` in the open task's project,
  with that task's agent and model, and hides the card. Without a project (a chat) the button is
  `aria-disabled` with a reason.
- **Edit** turns the title and text into fields (120 and 4,000 characters). Send request and Do
  it myself act on the edited text, saving it first (`feature_request_update`). Esc discards the
  edit. An empty field names itself (`Add a title`) instead of disabling a button.
- **Trash** ("Don't show feature requests again") hides the card and turns the cards off
  (`feature_requests_set_enabled(false)`); the toast offers Turn on and Settings.
- **Several cards:** one card is shown (the oldest still open) and a line "N more feature
  requests" lists the rest. A new card never replaces the one being read; it is announced in a
  polite live region.
- **Feedback** (sidebar footer, beside Help & support) opens the same form empty in a dialog:
  Send request, Do it myself, Cancel. Its draft survives Esc until the app closes.
- **Settings -> Agents -> Harnesses -> Feature request cards** is the switch (on by default).
  Off hides the cards and makes the tool answer `shown: false` so agents stop suggesting;
  saved requests return if it is switched on again. The Feedback button stays.

## Pieces

- Native (`src-tauri/src/feature_requests.rs`): storage in `feature-requests.json`, the tool,
  the commands `feature_requests_list`, `feature_request_update`, `feature_request_dismiss`,
  `feature_requests_enabled`, `feature_requests_set_enabled`, and the event
  `feature-requests-changed` (`{ sessionId }`). Deleting a task deletes its requests.
- Frontend: `mountFeatureRequests(host)` keeps one host element alive across composer redraws
  (`renderComposer` re-attaches it and calls `sync()`, which reloads when the thread changed).
  `main.ts` supplies the host (task creation, toasts, dialog); `settings.ts` draws the switch.
- Pure helpers, tested in `tests/feature-requests.test.mjs`: `issueDraft`, `issueUrl`,
  `requestProblem`.
- Trace row: `suggest_feature` in `src/tool-trace-pandacode-catalog.ts` ("Suggested a feature").

## Privacy

No telemetry and no network traffic from the app: the draft opens in the user's browser and
is sent only if they submit it on GitHub. The text of the request is the agent's; the app adds
no version, system or path.

## Preview and tests

`npm run dev` mocks every command in `src/preview.ts`; `?featurerequest` seeds a card for the
first task and `window.__previewFeatureRequest(sessionId, title, description)` adds one live.
`tests/feature-requests.spec.ts` covers the card, Edit, Send request (URL), Do it myself, the
trash and the Settings switch, queued cards and Feedback, in Chrome and WebKit. Set
`FR_PNG_DIR` to also write screenshots.
