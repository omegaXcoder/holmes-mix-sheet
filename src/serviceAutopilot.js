// Playwright automation for the Service Autopilot Dispatch Board.
//
// FRAGILITY NOTES (things most likely to break this, in rough order of likelihood):
//  1. The saved filter names ("AUTOMATION - mix sheet review - <Tech>") must exist and
//     match exactly (case-sensitive as typed in SA) - if someone renames/deletes one of
//     these saved views, that tech's run will time out waiting for the filter to appear.
//  2. This is a Knockout.js SPA panel, not classic postbacks - after selecting a filter or
//     date we verify the filter title / date box actually reflect the new selection before
//     proceeding (not just "did something change"), because a click can silently fail to
//     register (observed live) and leave the grid showing a DIFFERENT tech's or day's data
//     with no error. That happened for real: a Harris->Nate filter switch silently failed
//     and Nate's row got written with Harris's numbers. Both checks now throw loudly
//     instead of swallowing the timeout. If SA changes the "N Jobs Total" header wording
//     this final readiness wait needs updating too.
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

async function selectSavedFilter(page, filterName) {
  await page.locator('#screenViewTitleSpan').click();
  const item = page.locator('div.screenViewSelection', { hasText: filterName });
  await item.waitFor({ state: 'visible' });
  await item.click();

  // Verify the switch actually took effect by checking the filter title itself, NOT just
  // "did the job count change" - a click that silently fails to register (observed live:
  // clicking a filter item occasionally does nothing, for reasons not fully understood)
  // otherwise leaves the PREVIOUS tech's filter applied, and the job count can legitimately
  // differ day to day, so a changed count is not proof the right filter is now active. This
  // bit us for real: a Harris->Nate switch silently failed and the script scraped Harris's
  // data twice under Nate's name. Throwing here turns that into a loud, visible failure in
  // the audit email instead of silently writing wrong numbers into the sheet.
  await page
    .locator('#screenViewTitleSpan', { hasText: filterName })
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {
      throw new Error(
        `Filter switch to "${filterName}" did not take effect - the title still doesn't ` +
          'match after 15s. The grid may still be showing a different technician\'s data.'
      );
    });

  // The grid itself reloads via AJAX after the title updates - give it a moment to finish
  // rather than racing straight into reading rows.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('*')).some((e) => /^\d+ Jobs Total$/.test((e.textContent || '').trim())),
    null,
    { timeout: 15000 }
  );
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

  // Like the calendar cells above, this id is duplicated in the DOM (a hidden "Close"
  // copy alongside the live "Refresh" one) - scope to the visible one.
  await page.locator('#drpSaveButton:visible').first().click();

  // Verify the date range box itself now shows the target date, rather than just waiting
  // for the job count to change - the same silent-failure risk as the filter switch above
  // (a click that doesn't register would otherwise leave the grid on the WRONG day with no
  // error). This is a readonly input whose value is set via JS, not the HTML attribute, so
  // it has to be read via the live DOM property (evaluate), not a CSS attribute selector.
  const expected = `${String(month1to12).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
  await page
    .waitForFunction(
      (exp) => (document.getElementById('dispatchBoardDateRange')?.value || '').includes(exp),
      expected,
      { timeout: 15000 }
    )
    .catch(() => {
      throw new Error(
        `Date selection for ${expected} did not take effect - the date range box doesn't ` +
          'show it after 15s. The grid may still be showing the wrong day.'
      );
    });

  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('*')).some((e) => /^\d+ Jobs Total$/.test((e.textContent || '').trim())),
    null,
    { timeout: 15000 }
  );
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
  // Let the default view finish its initial render before interacting - clicking the
  // filter dropdown immediately after navigation occasionally hits "element is not
  // stable" because the page is still settling (e.g. a survey banner appearing and
  // shifting the layout right as the click lands).
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('*')).some((e) => /^\d+ Jobs Total$/.test((e.textContent || '').trim())),
    null,
    { timeout: 30000 }
  );
  await selectSavedFilter(page, filterName);
  await selectSingleDay(page, year, month, day);
  return extractJobRows(page);
}

module.exports = { login, getTechDayJobs, DISPATCH_BOARD_URL };
