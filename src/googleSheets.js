const { google } = require('googleapis');

function getAuth(keyPath) {
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

const DRIVE_LIST_DEFAULTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives',
};

// The top-level "Mix Sheets" folder doesn't hold monthly spreadsheets directly - it holds
// one subfolder per year (observed live: "Mix Sheets 26'" for 2026, "Mix Sheets 25'" for
// 2025 - note the trailing apostrophe and 2-digit year). This finds that year's subfolder.
async function findYearSubfolderId(auth, topFolderId, twoDigitYear) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${topFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    pageSize: 100,
    ...DRIVE_LIST_DEFAULTS,
  });
  const folders = res.data.files || [];
  const match = folders.find((f) => f.name.trim().match(new RegExp(`${twoDigitYear}'?$`)));
  if (!match) {
    throw new Error(
      `No year subfolder matching "${twoDigitYear}" found under the Mix Sheets folder. ` +
        `Found: ${folders.map((f) => f.name).join(', ')}`
    );
  }
  return match.id;
}

// Finds the monthly Mix Sheet spreadsheet inside the given year subfolder whose name
// matches the given pattern (e.g. /July\s+2026/i). Throws with the full listing if zero or
// more than one match is found, rather than guessing - a new month's sheet not existing
// yet, or two candidates matching (this has happened - e.g. a stray "Copy of FILLING
// MARCH 2026" sat next to "FILLING MARCH 2026"), both need a human to resolve.
async function findMonthlySpreadsheetId(auth, yearFolderId, namePattern) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${yearFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id, name)',
    pageSize: 100,
    ...DRIVE_LIST_DEFAULTS,
  });
  const files = res.data.files || [];
  const matches = files.filter((f) => namePattern.test(f.name));

  if (matches.length === 0) {
    throw new Error(
      `No spreadsheet in the year folder matched ${namePattern}. Found: ` +
        files.map((f) => f.name).join(', ')
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple spreadsheets matched ${namePattern}: ${matches.map((f) => f.name).join(', ')}`
    );
  }
  return matches[0].id;
}

// Finds the exact tab title (e.g. "7.) Wk/4 Mix") whose name contains the given needle
// (e.g. "wk/4 mix"), case-insensitively. Tab numbering prefixes shift as sheets are added,
// so we match on content, not position.
async function findSheetTabTitle(auth, spreadsheetId, needle) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = (res.data.sheets || []).map((s) => s.properties.title);
  const match = titles.find((t) => t.toLowerCase().includes(needle));
  if (!match) {
    throw new Error(`No tab matched "${needle}". Tabs found: ${titles.join(', ')}`);
  }
  return match;
}

async function writeCellValue(auth, spreadsheetId, a1Range, value) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1Range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

module.exports = {
  getAuth,
  findYearSubfolderId,
  findMonthlySpreadsheetId,
  findSheetTabTitle,
  writeCellValue,
};
