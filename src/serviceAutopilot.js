// Playwright automation for the Service Autopilot Dispatch Board.
//
// FRAGILITY NOTES (things most likely to break this, in rough order of likelihood):
//  1. The saved filter names ("AUTOMATION - mix sheet review - <Tech>") must exist and
//     match exactly (case-sensitive as typed in SA) - if someone renames/deletes one of
//     these saved views, that tech's run will time out waiting for the filter to appear.
//  2. This is a Knockout.js SPA panel, not classic postbacks - after every filter/date
//     change we wait on the "N Jobs Total" header text actually changing, since there's
//     no full page navigation to wait on. If SA changes that header's wording this wait
//     needs updating.
//  3. The date-range widget renders TWO copies of itself in the DOM (a live one and a
//     hidden dialog-only one) - every selector below is scoped to #drpMain and/or uses
//     Playwright's :visible pseudo-class to avoid grabbing the hidden copy.
//  4. Data is read via `ko.dataFor(row)` on the Knockout view model rather than scraping
//     visible cell text - far more reliable, but if SA upgrades/replaces the Knockout
//     version or renames the `Service` / `CustomField1` / `InternalSchedulingNotes`
//     observables, this breaks. Confirmed field names live on 2026-07-24.
//  5. Login is classic ASP.NET WebForms (full page postback) - everything after login is
//     an AJAX-driven SPA. Mixed wait strategies are used deliberately for this reason.

const SA_BASE_URL = 'https://my.serviceautopilot.com';
const DISPATCH_BOARD_URL = `${SA_BASE_URL}/DispatchBoard.aspx?type=db`;

async function login(page, email, password) {
  await page.goto(SA_BASE_URL);
  await page.locator('#txtLogin').fill(email);
  await page.locator('#txtPassword').fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.locator('#loginbtn').click(),
  ]);
}

async function getJobsTotalLabel(page) {
  return page.locator('text=/^\\d+ Jobs Total$/').first().innerText();
}

async function selectSavedFilter(page, filterName) {
  const before = await getJobsTotalLabel(page).catch(() => null);

  await page.locator('#screenViewTitleSpan').click();
  const item = page.locator('div.screenViewSelection', { hasText: filterName });
  await item.waitFor({ state: 'visible' });
  await item.click();

  // Selecting a filter reloads the grid via AJAX - wait for the job count text to change
  // (or simply appear, if this is the first filter selected this session) rather than
  // waiting on network idle, since Knockout SPAs keep background polling alive.
  await page.waitForFunction(
    (prevText) => {
      const el = Array.from(document.querySelectorAll('*')).find((e) =>
        /^\d+ Jobs Total$/.test((e.textContent || '').trim())
      );
      return el && el.textContent.trim() !== prevText;
    },
    before,
    { timeout: 15000 }
  ).catch(() => {
    // If the count happens to be numerically identical to the previous tech's count,
    // this timeout is a false alarm - fall through and let downstream checks catch a
    // genuinely stale grid instead of failing the whole run here.
  });
}

// Selects the exact given calendar date as a single-day range (start === end) and applies
// it. Relies on each day cell's `time` attribute being an exact epoch-millisecond
// timestamp, computed here via the SAME `new Date(y, m, d).getTime()` the page itself
// uses to stamp those cells, which sidesteps any timezone ambiguity.
async function selectSingleDay(page, year, month1to12, day) {
  await page.locator('#dispatchBoardDateRange').click();

  const targetMs = await page.evaluate(
    ([y, m, d]) => new Date(y, m - 1, d).getTime(),
    [year, month1to12, day]
  );

  const cell = page.locator(`#drpMain div.day[time="${targetMs}"]:visible`);

  // Navigate the picker backward if the target month isn't rendered yet (e.g. "yesterday"
  // fell into the previous month). Bounded retries - this should never need more than 2.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await cell.count()) break;
    await page.locator('#drpMain .prev:visible, #drpMain a[title="Prev"]:visible').first().click();
  }
  await cell.waitFor({ state: 'visible', timeout: 10000 });

  await cell.click(); // sets range start
  await cell.click(); // collapses range to a single day (start === end)

  const before = await getJobsTotalLabel(page).catch(() => null);
  // Like the calendar cells above, this id is duplicated in the DOM (a hidden "Close"
  // copy alongside the live "Refresh" one) - scope to the visible one.
  await page.locator('#drpSaveButton:visible').first().click();

  await page.waitForFunction(
    (prevText) => {
      const el = Array.from(document.querySelectorAll('*')).find((e) =>
        /^\d+ Jobs Total$/.test((e.textContent || '').trim())
      );
      return el && el.textContent.trim() !== prevText;
    },
    before,
    { timeout: 15000 }
  ).catch(() => {});
}

// Pulls every job row's Service name, turf sq ft (CustomField1), and scheduling note
// straight from the Knockout view model - see fragility note #4 above.
async function extractJobRows(page) {
  return page.evaluate(() => {
    function unwrap(v) {
      return typeof v === 'function' ? v() : v;
    }
    const rows = document.querySelectorAll('tr[id^="RowID"]');
    const out = [];
    rows.forEach((row) => {
      const data = window.ko && window.ko.dataFor(row);
      if (!data) return;
      out.push({
        client: unwrap(data.Client) || '',
        service: (unwrap(data.Service) || '').trim(),
        turfSqFt: parseFloat(unwrap(data.CustomField1)) || 0,
        schedulingNote: (unwrap(data.InternalSchedulingNotes) || '').trim(),
      });
    });
    return out;
  });
}

async function getTechDayJobs(page, { filterName, year, month, day }) {
  await page.goto(DISPATCH_BOARD_URL);
  await selectSavedFilter(page, filterName);
  await selectSingleDay(page, year, month, day);
  return extractJobRows(page);
}

module.exports = { login, getTechDayJobs, DISPATCH_BOARD_URL };
