// Figures out WHICH monthly spreadsheet, which "Wk/N Mix" tab, and which row block
// correspond to "yesterday" (the date this whole automation is always recording data for).
//
// Mix Sheet layout, confirmed live on the July 2026 sheet (see README):
//   - Each weekday block is 4 tech rows + 1 totals row + 1 blank row = 6 rows.
//   - Monday's F02 (first tech) row is row 4. Tuesday's is row 10, Wednesday's 16,
//     Thursday's 22, Friday's 28, Saturday's 34. i.e. row = 4 + 6 * weekdayIndex
//     (Mon=0 .. Sat=5), and a tech's exact row = that base + TECHS[i].sheetRowOffset.
//   - The "Sq Feet Per Tech" column is column C.
//   - Weeks are Monday-Saturday business weeks. Week 1 is the Mon-Sat block that contains
//     the 1st of the month (so it can start in the previous month, e.g. July 2026's Week 1
//     starts Monday June 29 because July 1 is a Wednesday) - confirmed live against the
//     sheet's own "today" conditional-formatting highlight, not assumed.
const MIX_SHEET_COLUMN = 'C';
const ROWS_PER_DAY_BLOCK = 6;
const FIRST_MONDAY_ROW = 4;

function getPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

// Returns the target date info (yesterday, in the business timezone) plus everything
// needed to locate its cell in the Mix Sheet.
function computeMixSheetTarget(now, timeZone) {
  const nowParts = getPartsInTimeZone(now, timeZone);
  // Anchor "today" at UTC noon so subtracting a day never crosses a DST boundary weirdly.
  const todayUtcNoon = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12);
  const yesterdayUtcNoon = todayUtcNoon - 24 * 60 * 60 * 1000;
  const yesterday = new Date(yesterdayUtcNoon);
  const y = yesterday.getUTCFullYear();
  const m = yesterday.getUTCMonth() + 1; // 1-12
  const d = yesterday.getUTCDate();

  const dow1 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const day1MondayIndex = (dow1 + 6) % 7; // 0=Mon..6=Sun
  const weekStartOfMonthUtc = Date.UTC(y, m - 1, 1) - day1MondayIndex * 24 * 60 * 60 * 1000;

  const targetUtc = Date.UTC(y, m - 1, d);
  const diffDays = Math.round((targetUtc - weekStartOfMonthUtc) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.floor(diffDays / 7) + 1;
  const weekdayIndex = diffDays % 7; // 0=Mon..6=Sun

  if (weekdayIndex === 6) {
    throw new Error(
      `Yesterday (${y}-${m}-${d}) is a Sunday - the Mix Sheet has no Sunday row. ` +
        'Nothing to record.'
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
    weekdayIndex, // 0=Mon .. 5=Sat
    row: FIRST_MONDAY_ROW + ROWS_PER_DAY_BLOCK * weekdayIndex,
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
