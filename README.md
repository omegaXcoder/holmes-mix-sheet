# Holmes Mix Sheet Automation

Each run: logs into Service Autopilot, reads each fert/pest technician's SCHEDULED jobs for
the next day (runs the evening before, so the mix sheet is ready ahead of time rather than
auditing completed work after the fact), reduces the turf sq ft total per the rules in
`src/config.js`, and writes the result into the correct cell of the current month's Mix
Sheet Google Sheet.

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
- `MIX_SHEET_TEMPLATE_ID` - already filled in, pointing at "NEW MASTER 2026 FILL SHEET" in
  the Mix Sheets folder. See "Automatic monthly sheet creation" below.
- `SMTP_FROM_EMAIL` / `SMTP_APP_PASSWORD` / `NOTIFY_EMAIL_TO` - see "Email notifications"
  below.

### 3a. Automatic monthly sheet creation

If this month's spreadsheet doesn't exist yet in its year folder (e.g. the first run of a
new month, or the automation failed for a stretch because nobody created it - this
happened for August 2026), the script duplicates `MIX_SHEET_TEMPLATE_ID`, names the copy
to match the existing convention (e.g. "AUGUST 2026 Mix Sheet"), places it in the correct
year folder, and deletes the template's placeholder "BLANK" tab from the copy. This is
logged and called out in the summary email so it doesn't happen silently.

This only creates the spreadsheet itself, not a missing *year* folder (e.g. January 2027)
- that edge case still throws and needs a human, since it hasn't come up yet. It also still
throws if more than one spreadsheet matches the target month (e.g. a stray duplicate) -
that's ambiguous and needs a human to resolve, same as before.

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
- There is no Sunday row - if tomorrow is a Sunday the script throws rather than guessing
  (the schedule already skips the Saturday-evening run that would target Sunday - see
  "Running on a schedule" below - so this is mainly a safety net for a manual/dispatch run).

If the sheet template ever changes (rows inserted/removed, techs reordered, a new tab
naming scheme), update `src/mixSheetTarget.js` and `src/config.js` accordingly - these
numbers are not derived from anything self-describing in the sheet, they're hardcoded from
what we observed.

## Known fragile points

Roughly in order of how likely each is to actually break something:

1. **Stale grid data after a filter/date change looks identical to success.** The single
   most dangerous failure mode found so far - not a crash, a silent wrong answer. Selecting
   a filter or date updates its on-screen control (title text / date box) near-instantly,
   client-side, but the grid's own AJAX data refresh can lag behind that by a noticeable
   moment. Reading rows in that gap returns the PREVIOUS filter's or day's data with no
   error at all - found live: switching from Aug 24 to Aug 25 left the date box correctly
   showing Aug 25, yet the scraped totals matched Aug 24's real numbers exactly, to the
   cent. Both `selectSavedFilter` and `selectSingleDay` now additionally wait for the
   Totals row's grand total (`CustomField1Total`) to actually change from its value before
   the switch, and throw if it doesn't within 20s - far more reliable than waiting for the
   job count to change, since two different techs/days can coincidentally share a count but
   essentially never share this decimal total to the cent. If this check ever throws in
   practice where the total genuinely was supposed to stay the same (e.g. a tech with
   identical totals two days running), that's a rare false alarm worth knowing about, but
   the alternative - silently writing the wrong day's numbers - is much worse.
2. **Saved filter names in SA.** `AUTOMATION - mix sheet review - <Tech>` must exist under
   that exact name for each tech. If renamed/deleted, that tech's run hangs waiting for the
   filter option to appear (10s timeout, then throws).
3. **Service name matching.** Reduction logic is "no 'fert' in the name -> reduce", with
   "contains 'free'" always overriding that to reduce regardless (needed because some free
   follow-up services are catalogued under a category label that itself contains "fert",
   e.g. "Lawn Fertilizing & Weed Control:Free Follow Up Weed Control"), plus a
   spring-seeding-note carve-out for lawn fert 1-2 of 7 (see `src/config.js` for the full
   reasoning). If Service Autopilot service names change, this may over- or under-reduce
   silently - there's no built-in alerting for "this service name looks new/unexpected."
4. **Google Sheet template stability.** Row/column numbers in `mixSheetTarget.js` are
   hardcoded from observing the live sheet, not computed from headers. A structural change
   to the sheet (inserted row, reordered techs) silently writes to the wrong cell.
5. **Knockout data model field names** (`Service`, `CustomField1`,
   `InternalSchedulingNotes`) - confirmed live 2026-07-24. An SA platform upgrade could
   rename these.
6. **Date-picker DOM duplication.** The date range widget renders a second, hidden copy of
   itself (used for an edit-row dialog elsewhere on the page). Every date selector is scoped
   to `#drpMain` and/or `:visible` to avoid grabbing the wrong copy - if SA adds a third
   copy or changes the wrapper ID, this needs revisiting.
7. **Spreadsheet-per-month lookup.** `ensureMonthlySpreadsheet` creates the month's
   spreadsheet from the template if it's missing (see "Automatic monthly sheet creation"
   above), but still throws if the *year* folder is missing (e.g. no "Mix Sheets 27'"
   folder exists yet come January 2027) or if more than one file matches the target month.
8. **ASP.NET WebForms login.** Login is a classic full-postback form; everything after is
   an AJAX SPA. If SA changes the login page to also be SPA-driven, the
   `waitForNavigation` after clicking Login will need to become a different wait strategy.
9. **Business timezone assumption.** All "what day is it" / week-of-month math is anchored
   to `BUSINESS_TIMEZONE` (`America/Denver` by default) specifically to avoid UTC-vs-local
   off-by-one-day bugs. If this ever runs from a scheduler in a different timezone context,
   double check this still resolves correctly, especially since it now runs in the evening
   (closer to the UTC date rollover than the old next-morning schedule was).
10. **Duplicate DOM ids on the Dispatch Board.** It's not just the date-picker calendar that
    gets duplicated - `#drpSaveButton` also exists twice (a hidden "Close" copy alongside the
    live "Refresh" one). Any new selector added here should be checked for this same pattern
    (`:visible` + `.first()`) before assuming a single match.
11. **chrome.exe failing to launch on some Windows machines.** On the machine this was
    built on, the full `chrome.exe` Playwright installs fails with a Windows-level "side-by-
    side configuration is incorrect" error (unrelated to this code - `chrome.exe --version`
    fails the same way run standalone). The separate `chrome-headless-shell` binary
    Playwright also installs works fine, so `src/run.js` launches via
    `channel: 'chromium-headless-shell'` whenever `HEADLESS=true`. Headed mode
    (`HEADLESS=false`, useful for interactively debugging selectors) still needs a working
    `chrome.exe` - if it fails the same way, that's a machine-level issue to fix separately
    (try reinstalling the Visual C++ Redistributable, or `npx playwright install chromium
    --force`), not something to work around in code.
12. **Intermittent "element is not stable/visible" on the very first interaction of a fresh
    browser.** Only ever hit whichever tech runs first (always David, since `TECHS` order is
    fixed), and never recurs later in the same run - looks tied to the browser having just
    launched, but the exact root cause wasn't pinned down (tried waiting for the page's
    initial render to settle first; that didn't fully fix it). Mitigated rather than fixed:
    a tech whose scrape fails gets one retry, run after every other tech has gone (i.e.
    genuinely not first anymore) instead of immediately - see `processTechs` in
    `src/run.js`. Set `DEBUG_SCREENSHOTS=true` to dump a screenshot + the target element's
    computed style/bounding box to `debug-screenshots/` the next time a filter-switch click
    fails, if this needs deeper investigation later.

## Notes on credentials

`SA_PASSWORD` and the service account key are read from `.env` / the JSON key file - never
hardcoded in source. Keep both out of version control.

## Running on a schedule (GitHub Actions)

`.github/workflows/mix-sheet-automation.yml` runs this automatically at 8pm MDT (Mountain
Daylight Time) every evening EXCEPT Saturday - it pulls each tech's *scheduled* jobs for
the next day, so a Saturday-evening run would target Sunday, and the sheet has no Sunday
row. This is a fixed UTC time, not DST-aware, so it drifts to 7pm local during Mountain
Standard Time (winter) - accepted as fine rather than adding a second DST-aware schedule.

The cron entry itself is `0 2 * * 1,2,3,4,5,6` (02:00 UTC) - worth understanding why those
numbers don't obviously say "skip Saturday": 8pm Mountain time crosses midnight UTC,
landing on the *next* UTC calendar day. Business Saturday 8pm MDT is Sunday 02:00 UTC, so
the day-of-week actually being skipped is Sunday (`0`) in UTC terms - `1,2,3,4,5,6` is
every day except UTC-Sunday, which works out to every business evening except Saturday.
This happens to look like "just skip Sunday", but that's a coincidence of this particular
schedule, not a rule - if the time or skip day ever changes again, recompute this
explicitly (for each business day, add 6 hours to 20:00 that day and check what UTC
day-of-week results) rather than assuming the pattern holds.

It can also be triggered manually from the **Actions** tab (with an optional dry-run
checkbox) for testing.

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
