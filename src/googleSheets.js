const { google } = require('googleapis');

function getAuth(keyPath) {
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    // Full drive scope (not drive.readonly) - creating each new month's spreadsheet from
    // the template requires write access, not just browsing.
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
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

// Lists every spreadsheet in the given year subfolder whose name matches the given pattern
// (e.g. /July\s+2026/i). Does NOT throw on zero matches - callers decide what "missing"
// means (ensureMonthlySpreadsheet below creates one; other callers might want to just know).
async function listMonthlySpreadsheetMatches(auth, yearFolderId, namePattern) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${yearFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id, name)',
    pageSize: 100,
    ...DRIVE_LIST_DEFAULTS,
  });
  const files = res.data.files || [];
  return files.filter((f) => namePattern.test(f.name));
}

// Duplicates the monthly template spreadsheet into the given year folder under the given
// name, then deletes its placeholder "BLANK" tab (present in the template so it always has
// at least one non-Mix/Calibration tab to open to by default - not meant to ship in real
// monthly sheets). Matches the tab by title rather than assuming its internal sheetId
// survives the copy identically, even though in practice it does.
async function createMonthlySpreadsheetFromTemplate(auth, { templateId, yearFolderId, fileName, blankTabTitle = 'blank' }) {
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  const copyRes = await drive.files.copy({
    fileId: templateId,
    supportsAllDrives: true,
    requestBody: { name: fileName, parents: [yearFolderId] },
  });
  const newSpreadsheetId = copyRes.data.id;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: newSpreadsheetId,
    fields: 'sheets.properties',
  });
  const blankTab = (meta.data.sheets || []).find(
    (s) => s.properties.title.trim().toLowerCase() === blankTabTitle.toLowerCase()
  );
  if (blankTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: newSpreadsheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: blankTab.properties.sheetId } }] },
    });
  }

  return newSpreadsheetId;
}

// Finds this month's spreadsheet in the given year folder, creating it from the template
// if it doesn't exist yet (e.g. the first run of a new month). Still throws if MORE than
// one candidate matches - that's ambiguous (has happened before - a stray duplicate sitting
// next to the real file) and needs a human to resolve, not a guess.
async function ensureMonthlySpreadsheet(auth, { yearFolderId, namePattern, fileName, templateId }) {
  const matches = await listMonthlySpreadsheetMatches(auth, yearFolderId, namePattern);

  if (matches.length > 1) {
    throw new Error(
      `Multiple spreadsheets matched ${namePattern}: ${matches.map((f) => f.name).join(', ')}`
    );
  }
  if (matches.length === 1) {
    return { spreadsheetId: matches[0].id, created: false };
  }

  const spreadsheetId = await createMonthlySpreadsheetFromTemplate(auth, {
    templateId,
    yearFolderId,
    fileName,
  });
  return { spreadsheetId, created: true };
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
  ensureMonthlySpreadsheet,
  findSheetTabTitle,
  writeCellValue,
};
