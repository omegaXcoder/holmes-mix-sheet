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
6. Add that email as a **member of the shared drive** (open the "Drive" shared drive >
   its name at the top > Manage members > add the email as at least **Content manager**).
   One membership covers every year subfolder and monthly spreadsheet inside it,
   including future months. Note: the drive doesn't hold monthly spreadsheets directly at
   its root - it holds one subfolder per year (e.g. "Mix Sheets 26'" for 2026), and the
   monthly sheets live inside those. (Historical note: before 2026-09-02 everything lived
   in a regular My Drive "Mix Sheets" folder shared with the service account as Editor -
   that stopped working for creating new monthly sheets; see "Drive storage quota /
   monthly sheet creation" below.)

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

### 3a-bis. Drive storage quota / monthly sheet creation

**The failure this section fixes** (hit live on 2026-08-31, the first run that needed to
create "SEPTEMBER 2026 Mix Sheet"): the template copy fails with

> GaxiosError: The user's Drive storage quota has been exceeded. (reason: storageQuotaExceeded)

This is **not** anyone's Drive being full. As of April 2025, Google gives service accounts
**0 bytes** of Drive storage, so a service account can no longer *own* files. Copying the
template into a regular My Drive folder makes the service account the owner of the copy -
instantly over its 0-byte quota. Writing values into *existing* sheets is unaffected (no
new file is created); only the once-a-month "create this month's sheet" step breaks.

Two ways to fix it - pick ONE:

**STATUS: Option A was done on 2026-09-02** - the "Mix Sheets 26'" year folder now lives
at the root of the "Drive" shared drive (`0AIRkxE8Y7Sr8Uk9PVA`, now the value of
`MIX_SHEETS_FOLDER_ID` - shared-drive root ids start with `0A`). There is no longer a
top-level "Mix Sheets" wrapper folder; the shared drive root plays that role, so future
year folders ("Mix Sheets 27'" etc) should be created directly in the shared drive root.
Loose end at time of writing: the TEMPLATE was not moved and still sits in the old
My Drive folder with no share to the service account - move it into the shared drive
(its ID survives the move; no config change needed) before the first run of a new month
needs to copy it.

**Option A - move the Mix Sheets folder into a Shared Drive (recommended).** Files in a
Shared Drive are owned by the drive itself, not by whoever created them, so the quota rule
never applies. The code already passes `supportsAllDrives` on every Drive call, so no code
or configuration change is needed beyond the move:

1. In Google Drive (as a user on the Workspace plan - Shared Drives require Business
   Starter or above), create a Shared Drive, e.g. "Holmes Mix Sheets".
2. Move the top-level **Mix Sheets** folder (with its year subfolders and the template)
   into it. Moving folders into a Shared Drive may require a Workspace admin, depending on
   the domain's sharing settings.
3. Add the service account's `client_email` as a **Content manager** member of the Shared
   Drive (the old folder-level share doesn't follow the files into the shared drive
   reliably - a drive-level membership does).
4. Verify `MIX_SHEETS_FOLDER_ID` and `MIX_SHEET_TEMPLATE_ID` still match - IDs normally
   survive the move, but open the folder/template in the browser and compare the IDs in
   the URL against the workflow file, and update the workflow env values if they changed.

**Option B - domain-wide delegation (if a Shared Drive isn't an option).** The service
account impersonates a real Workspace user, so new monthly sheets are created as - and
owned by - that user:

1. Find the service account's **Client ID** (numeric, not the email): Google Cloud Console
   > IAM & Admin > Service Accounts > your account > "Unique ID".
2. In the **Google Workspace Admin console** (admin.google.com, requires super admin on
   holmesutah.com or wherever the sheets live): **Security > Access and data control > API
   controls > Domain-wide delegation > Add new**. Paste the Client ID and grant exactly
   these scopes (comma-separated):
   `https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive`
3. Set `GOOGLE_IMPERSONATE_USER` to the email of a user who has edit access to the Mix
   Sheets folder (e.g. `madison@holmesutah.com`) - in `.env` locally, and as a
   **repository variable** (Settings > Secrets and variables > Actions > Variables tab -
   it's just an email, not a secret) for the GitHub Actions run.

Note: with impersonation on, ALL Drive/Sheets calls act as that user, so it's their access
(not the service account's share) that matters. Impersonation only works for Workspace
accounts on the domain that granted the delegation - not for plain @gmail.com accounts.

If neither option is set up and the quota error hits again, the script now fails with a
message explaining all of this instead of the raw Google error, and the failure email
carries that explanation.

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
   - `NOTIFY_EMAIL_TO` - already defaulted to `omega@kudos.marketing,madison@holmesutah.com`
     (comma-separated for multiple recipients - nodemailer passes this straight through).

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
  directly under the root of the "Drive" shared drive (before 2026-09-02: under a
  top-level "Mix Sheets" My Drive folder), named like `<Month> <Year> Mix Sheet`. Older months
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
   the switch, and throw if it doesn't within 45s (bumped up from an initial 20s after a
   real production run legitimately needed longer - see the postmortem below) - far more
   reliable than waiting for the job count to change, since two different techs/days can
   coincidentally share a count but essentially never share this decimal total to the cent.
   If this check ever throws in practice where the total genuinely was supposed to stay the
   same (e.g. a tech with identical totals two days running), that's a rare false alarm
   worth knowing about, but the alternative - silently writing the wrong day's numbers - is
   much worse.
   **2026-08-27 production incident**: the scheduled run failed for all 4 techs with this
   exact error - David's filter total updated but the date-change total never budged from
   131185.62 in 20s, then Brandt/Harris/Nate's totals never left `null` at all, even across
   retries. That evening's scheduled trigger also fired ~10 hours late (12:13 UTC instead
   of the scheduled 02:00 UTC - a GitHub Actions scheduling delay, not a bug here), which
   may or may not be related. Surrounding days ran on-time and succeeded, so this looked
   like a one-off SA-side slowness/GitHub-scheduling blip rather than a persistent problem
   - the timeout was bumped to 45s as a reasonable hedge, and the run was backfilled
   manually. If this recurs, it's worth checking GitHub's Actions status history for that
   window and/or bumping the timeout further.
   **2026-08-28 incident + re-diagnosis of the above**: the run recording Saturday
   2026-08-29 failed for all 4 techs with the same guard, and this time the real cause was
   found: the target day had ZERO scheduled jobs. An empty day renders no Totals row at
   all, so the "wait for the grand total to change" check could never succeed - the total
   read `null` forever. And because SA persists the selected date across page loads within
   a session, one empty target day poisoned every subsequent tech's scrape too: their
   fresh page loads started out already showing the empty day ("never changed from null"),
   including all retries. The 2026-08-27 incident above has this exact signature in its
   log (first tech stuck at a real number after the date change, everyone after stuck at
   null) and was almost certainly this same blind spot, not SA slowness or the GitHub
   scheduling delay. Fixed in `waitForGridRefresh` (`src/serviceAutopilot.js`): on
   timeout, the grid's final state is inspected, and a stable, coherent empty state (zero
   job rows + a literal "0 Jobs Total" header + missing/zero total) is accepted as a
   legitimately empty day - the run records 0.00, which is the truth, and the summary
   email calls out any zero-job tech explicitly so a human can sanity-check it. Anything
   else on timeout still throws as stale data, exactly as before. Known residual risk: a
   refresh slower than the full 45s timeout on a day that genuinely has jobs, while the
   grid shows a coherent empty state throughout, would record 0.00 instead of failing -
   the email's zero-jobs note is the audit hook for that case.
   **2026-08-31 incident (recording Wednesday 2026-09-02) - a THIRD grid state**: the
   very next run failed for all 4 techs with a new signature: `job rows: 1, total:
   "null", "0 Jobs Total" header: false`. A SPARSE day (a single job per tech) renders
   job rows but NO CustomField1Total element at all - not empty (so the empty-day
   fallback rightly refused it), but the "wait for the total to change" signal could
   never fire either, because there is no total to change. Fixed by making the primary
   refresh signal independent of the Totals row: `captureGridBeforeChange` marks every
   pre-change row node with a `data-pre-refresh` attribute, and when the grid's AJAX
   refresh lands, Knockout re-renders the rows from brand-new data objects, replacing
   every marked node - so "no marked nodes remain" means the refresh landed regardless of
   what the new day looks like (many jobs, one job, or none). "Total changed" is retained
   as a secondary signal, and the stable-coherent-empty timeout fallback stays for
   empty-to-empty transitions (nothing marked, nothing to replace). See
   `waitForGridRefresh` in `src/serviceAutopilot.js` for the full three-generation
   history of this guard.
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
   Creating the sheet also requires either a Shared Drive or domain-wide delegation -
   service accounts can't own files in a regular My Drive anymore (0-byte quota since
   April 2025; hit live 2026-08-31) - see "Drive storage quota / monthly sheet creation".
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

One optional value comes from a repository **variable** (Settings > Secrets and variables >
Actions > **Variables** tab) rather than a secret, since it's just an email address:

| Variable name | Value |
| --- | --- |
| `GOOGLE_IMPERSONATE_USER` | Workspace user the service account impersonates when creating a new month's sheet (only needed with the domain-wide delegation setup - see "Drive storage quota / monthly sheet creation"; leave unset when using a Shared Drive) |
