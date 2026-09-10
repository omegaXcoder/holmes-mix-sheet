// Figures out WHICH monthly spreadsheet and which "Wk/N Mix" tab correspond to the date
// being recorded - nominally TOMORROW (the run fires the evening before, pulling each
// tech's SCHEDULED jobs for the next day so the mix sheet is ready ahead of time, not
// auditing completed work after the fact), but see computeMixSheetTarget for how a run
// delayed past midnight still records the correct day.
//
// Mix Sheet layout, confirmed live on the July 2026 sheet (see README):
//   - Within a week tab, each weekday is a block of one row per tech (labeled
//     "F0N (Name)" in column B) plus a totals row and a blank spacer. The EXACT row for a
//     given tech+day is no longer computed here from hardcoded offsets - it's resolved at
//     runtime by findTechDayRow in googleSheets.js, which scans column B for the tech's
//     code, so the sheet itself is the source of truth and layout changes (like adding a
//     technician) don't require code edits.
//   - The "Sq Feet Per Tech" column is column C.
//   - Weeks are Monday-Saturday business weeks. Week 1 is the Mon-Sat block that contains
//     the 1st of the month (so it can start in the previous month, e.g. July 2026's Week 1
//     starts Monday June 29 because July 1 is a Wednesday) - confirmed live against the
//     sheet's own "today" conditional-formatting highlight, not assumed.
const MIX_SHEET_COLUMN = 'C';

function getPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23', // 0-23, avoiding the "24:xx at midnight" quirk of hour12:false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
  };
}

// Returns the target date's info (in the business timezone) plus everything needed to
// locate its cells in the Mix Sheet.
//
// The target is "the date of the NEXT MORNING", not literally "tomorrow". The run is
// scheduled for the evening before the day it records, but GitHub's cron is best-effort
// and has fired ~5 hours late in production - past local midnight (observed live: the 8pm
// MDT schedule regularly starting between 12:30 and 1am MDT). Recording literal
// "tomorrow" from a past-midnight run skips a day: the 2026-08-31 07:58 UTC run recorded
// 09-01 and silently left 08-31 blank, and the 2026-09-10 00:53 MDT run recorded 09-11,
// leaving 09-10 blank. So: before noon local, the run is treated as a late fire of the
// previous evening and records TODAY; from noon on, it records tomorrow as intended. A
// manual morning run therefore backfills the current day (usually what a human doing
// that wants); the log line and audit email always state the exact date recorded.
function computeMixSheetTarget(now, timeZone) {
  const nowParts = getPartsInTimeZone(now, timeZone);
  // Anchor "today" at UTC noon so adding a day never crosses a DST boundary weirdly.
  const todayUtcNoon = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12);
  const targetUtcNoon = nowParts.hour < 12 ? todayUtcNoon : todayUtcNoon + 24 * 60 * 60 * 1000;
  if (nowParts.hour < 12) {
    console.log(
      `Run started before noon (${String(nowParts.hour).padStart(2, '0')}:xx local) - ` +
        'treating it as a late fire of the previous evening and recording TODAY, not tomorrow.'
    );
  }
  const targetDate = new Date(targetUtcNoon);
  const y = targetDate.getUTCFullYear();
  const m = targetDate.getUTCMonth() + 1; // 1-12
  const d = targetDate.getUTCDate();

  const dow1 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const day1MondayIndex = (dow1 + 6) % 7; // 0=Mon..6=Sun
  const weekStartOfMonthUtc = Date.UTC(y, m - 1, 1) - day1MondayIndex * 24 * 60 * 60 * 1000;

  const targetUtc = Date.UTC(y, m - 1, d);
  const diffDays = Math.round((targetUtc - weekStartOfMonthUtc) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.floor(diffDays / 7) + 1;
  const weekdayIndex = diffDays % 7; // 0=Mon..6=Sun

  if (weekdayIndex === 6) {
    throw new Error(
      `The target date (${y}-${m}-${d}) is a Sunday - the Mix Sheet has no Sunday row. Nothing to record.`
    );
  }

  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });

  return {
    year: y,
    month: m,
    day: d,
    monthName,
    weekNumber,
    weekdayIndex, // 0=Mon .. 5=Sat - findTechDayRow turns this into an exact row per tech
    column: MIX_SHEET_COLUMN,
    // e.g. "26" - used to find the year's subfolder in Drive (see googleSheets.js)
    yearShort: String(y).slice(-2),
    // e.g. "July 2026" - used to find the right monthly spreadsheet within that subfolder
    spreadsheetNamePattern: new RegExp(`${monthName}\\s+${y}`, 'i'),
    // e.g. "JULY 2026 Mix Sheet" - matches the existing naming convention exactly, used as
    // the file name if this month's spreadsheet has to be created from the template
    spreadsheetFileName: `${monthName.toUpperCase()} ${y} Mix Sheet`,
    // e.g. "wk/4 mix" - used to find the right tab within that spreadsheet
    sheetTabNameNeedle: `wk/${weekNumber} mix`,
  };
}

function cellA1(target, sheetTitle) {
  // Sheet titles contain special characters (".", "/") so they must be single-quoted,
  // and any literal single quote in the title must be escaped by doubling it.
  const quotedTitle = `'${sheetTitle.replace(/'/g, "''")}'`;
  return `${quotedTitle}!${target.column}${target.row}`;
}

module.exports = { computeMixSheetTarget, cellA1 };
