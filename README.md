# Holmes Mix Sheet Automation

Each run: logs into Service Autopilot, reads yesterday's jobs for each fert/pest technician,
reduces the turf sq ft total per the rules in `src/config.js`, and writes the result into
the correct cell of the current month's Mix Sheet Google Sheet.

## One-time setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Create a Google Cloud service account (for the Sheets/Drive API)

The script never opens a Google login page - it authenticates as its own robot account.

1. Go to https://console.cloud.google.com/ and create a new project (or pick an existing one).
2. **APIs & Services > Library** - enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services > Credentials > Create Credentials > Service Account**. Give it any
   name (e.g. `mix-sheet-bot`). No project-level role is needed - skip that step.
4. Open the new service account > **Keys > Add Key > Create new key > JSON**. This
   downloads a `.json` file - save it as `service-account-key.json` in this project folder
   (it's already covered by `.gitignore`-equivalent handling below; don't commit it anywhere).
5. Open the JSON file and copy the `client_email` value (looks like
   `mix-sheet-bot@your-project.iam.gserviceaccount.com`).
6. In Google Drive, right-click the **Mix Sheets** folder > **Share** > paste that email
   in as an **Editor**. This one share covers every monthly spreadsheet inside the folder,
   including future months, as long as new sheets are created inside that same folder.
   Note: the Mix Sheets folder doesn't hold monthly spreadsheets directly - it holds one
   subfolder per year (e.g. "Mix Sheets 26'" for 2026), and the monthly sheets live inside
   those. Sharing the top-level Mix Sheets folder covers all of them; you don't need to
   share each year subfolder separately.

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:
- `SA_EMAIL` / `SA_PASSWORD` - the Service Autopilot login this should run as. **If the
  password contains a `#`, wrap the whole value in double quotes**
  (`SA_PASSWORD="abc#def"`) - dotenv treats an unquoted `#` as a comment start and silently
  truncates everything after it. This bit us during setup: an unquoted password got cut
  down to 3 characters with no error, just a login that mysteriously never navigated.
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` - path to the JSON key from step 2.
- `MIX_SHEETS_FOLDER_ID` - already filled in from the folder link you gave; change it if
  the folder moves.
- `SMTP_FROM_EMAIL` / `SMTP_APP_PASSWORD` / `NOTIFY_EMAIL_TO` - see "Email notifications"
  below.

### 3b. Email notifications

Every run - success or failure - sends a summary email to `NOTIFY_EMAIL_TO` with the
subject line `Mix Sheet Automation - SUCCESS - <date>` or `... - FAILURE - <date>`, listing
every job whose sq ft was subtracted out of the total, per tech, so it's easy to audit what
the automation actually did.

This is sent via Gmail SMTP with an App Password (not a full Google login):

1. On the Google account you want to send FROM, go to **Google Account > Security > 2-Step
   Verification** and enable it if it isn't already (App Passwords require this).
2. **Security > App Passwords** > create one (name it e.g. `mix-sheet-bot`) > copy the
   16-character password it gives you.
3. Fill in `.env`:
   - `SMTP_FROM_EMAIL` - the account you just did this on.
   - `SMTP_APP_PASSWORD` - the 16-character password (this is NOT that account's normal
     login password - Gmail rejects normal passwords for SMTP).
   - `NOTIFY_EMAIL_TO` - already defaulted to `omega@kudos.marketing`.

A single tech failing (e.g. a saved filter got renamed) doesn't stop the other techs from
being processed and written - the email will show that tech's error while still reporting
the others' results normally. The subject line only says SUCCESS if every tech scraped
*and* wrote cleanly.

### 4. First run - use dry-run mode

With `DRY_RUN=true` in `.env`, run:

```bash
npm start
```

This does everything (login, scrape, compute) but only *prints* what it would write,
instead of writing it. Confirm the numbers look right, then set `DRY_RUN=false` in `.env`
before running for real:

```bash
npm start
```

## Mix Sheet layout this script assumes

Confirmed live against the July 2026 sheet on 2026-07-24 - see conversation history for how
this was derived, including double-checking the "current week" tab against the sheet's own
date-driven conditional formatting rather than assuming from calendar math alone.

- Each monthly spreadsheet lives inside a year subfolder (e.g. "Mix Sheets 26'" for 2026)
  under the top-level Mix Sheets folder, named like `<Month> <Year> Mix Sheet`. Older months
  use inconsistent naming (e.g. "FILLING MARCH 2026", and 2025's folder drops the "Mix
  Sheet" suffix entirely) - this only matters if the script is ever extended to look back
  at past months.
- Weekly tabs are named like `7.) Wk/4 Mix` - matched by the `Wk/N Mix` substring, not the
  numeric prefix (which shifts as sheets are added/removed).
- Weeks are Monday-Saturday business weeks. Week 1 is whichever Mon-Sat block contains the
  1st of the month (it can start in the previous month).
- Within a week's tab, each weekday is a 6-row block: 4 tech rows (David, Brandt, Harris,
  Nate, in that order) + 1 totals row + 1 blank spacer row. Monday's first tech row is row
  4; each subsequent day's block starts 6 rows later (Tuesday 10, Wednesday 16, Thursday 22,
  Friday 28, Saturday 34).
- The "Sq Feet Per Tech" column is column C.
- There is no Sunday row - if "yesterday" is a Sunday the script throws rather than guessing.

If the sheet template ever changes (rows inserted/removed, techs reordered, a new tab
naming scheme), update `src/mixSheetTarget.js` and `src/config.js` accordingly - these
numbers are not derived from anything self-describing in the sheet, they're hardcoded from
what we observed.

## Known fragile points

Roughly in order of how likely each is to actually break something:

1. **Saved filter names in SA.** `AUTOMATION - mix sheet review - <Tech>` must exist under
   that exact name for each tech. If renamed/deleted, that tech's run hangs waiting for the
   filter option to appear (10s timeout, then throws).
2. **Service name matching.** Reduction logic is "no 'fert' in the name -> reduce" plus a
   spring-seeding-note carve-out for lawn fert 1-2 of 7 (see `src/config.js` for the full
   reasoning). If Service Autopilot service names change, this may over- or under-reduce
   silently - there's no built-in alerting for "this service name looks new/unexpected."
3. **Google Sheet template stability.** Row/column numbers in `mixSheetTarget.js` are
   hardcoded from observing the live sheet, not computed from headers. A structural change
   to the sheet (inserted row, reordered techs) silently writes to the wrong cell.
4. **Knockout data model field names** (`Service`, `CustomField1`,
   `InternalSchedulingNotes`) - confirmed live 2026-07-24. An SA platform upgrade could
   rename these.
5. **Date-picker DOM duplication.** The date range widget renders a second, hidden copy of
   itself (used for an edit-row dialog elsewhere on the page). Every date selector is scoped
   to `#drpMain` and/or `:visible` to avoid grabbing the wrong copy - if SA adds a third
   copy or changes the wrapper ID, this needs revisiting.
6. **Spreadsheet-per-month lookup.** If next month's spreadsheet doesn't exist yet in the
   Drive folder when this runs (e.g. run right at midnight on the 1st before someone's
   created it), `findMonthlySpreadsheetId` throws rather than creating one.
7. **ASP.NET WebForms login.** Login is a classic full-postback form; everything after is
   an AJAX SPA. If SA changes the login page to also be SPA-driven, the
   `waitForNavigation` after clicking Login will need to become a different wait strategy.
8. **Business timezone assumption.** All "yesterday" / week-of-month math is anchored to
   `BUSINESS_TIMEZONE` (`America/Denver` by default) specifically to avoid UTC-vs-local
   off-by-one-day bugs. If this ever runs from a scheduler in a different timezone context,
   double check this still resolves correctly around midnight.
9. **Duplicate DOM ids on the Dispatch Board.** It's not just the date-picker calendar that
   gets duplicated - `#drpSaveButton` also exists twice (a hidden "Close" copy alongside the
   live "Refresh" one). Any new selector added here should be checked for this same pattern
   (`:visible` + `.first()`) before assuming a single match.
10. **chrome.exe failing to launch on some Windows machines.** On the machine this was
    built on, the full `chrome.exe` Playwright installs fails with a Windows-level "side-by-
    side configuration is incorrect" error (unrelated to this code - `chrome.exe --version`
    fails the same way run standalone). The separate `chrome-headless-shell` binary
    Playwright also installs works fine, so `src/run.js` launches via
    `channel: 'chromium-headless-shell'` whenever `HEADLESS=true`. Headed mode
    (`HEADLESS=false`, useful for interactively debugging selectors) still needs a working
    `chrome.exe` - if it fails the same way, that's a machine-level issue to fix separately
    (try reinstalling the Visual C++ Redistributable, or `npx playwright install chromium
    --force`), not something to work around in code.

## Notes on credentials

`SA_PASSWORD` and the service account key are read from `.env` / the JSON key file - never
hardcoded in source. Keep both out of version control.

## Running on a schedule (GitHub Actions)

`.github/workflows/mix-sheet-automation.yml` runs this automatically at 16:00 UTC (10am
MDT) every day except Monday - the business doesn't run Sundays, so there'd be nothing for
a Monday run to record. This is a fixed UTC time, not DST-aware, so it drifts to 9am local
during Mountain Standard Time (winter) - accepted as fine rather than adding a second
DST-aware schedule. It can also be triggered manually from the **Actions** tab (with an
optional dry-run checkbox) for testing.

The workflow reads everything from **repository secrets** rather than committing `.env` -
add these under **Settings > Secrets and variables > Actions > New repository secret**:

| Secret name | Value |
| --- | --- |
| `SA_EMAIL` | Service Autopilot login email |
| `SA_PASSWORD` | Service Autopilot login password |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | The **entire contents** of `service-account-key.json`, pasted as-is (it's valid JSON, the workflow writes it straight to a file) |
| `SMTP_FROM_EMAIL` | The Gmail account sending the audit emails |
| `SMTP_APP_PASSWORD` | That account's 16-character Gmail App Password |

To skip clicking through the UI five times, `scripts/upload-secrets.ps1` reads these
straight out of your local `.env` and `service-account-key.json` and uploads them via `gh
secret set`. Requires the [GitHub CLI](https://cli.github.com/) installed and
`gh auth login` run once first. Then, from the project folder:

```powershell
.\scripts\upload-secrets.ps1
```

Everything else (folder ID, timezone, notify-to address, SMTP host/port) is non-sensitive
and hardcoded directly in the workflow file - edit it there if any of those change.
