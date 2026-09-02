const { google } = require('googleapis');

// impersonateUser (optional): a real Workspace user's email to act as via domain-wide
// delegation. Needed when the Mix Sheets folder lives in a regular My Drive: service
// accounts have 0 bytes of Drive storage (Google policy change, April 2025) and therefore
// can't OWN new files, so the monthly template copy fails with storageQuotaExceeded unless
// the copy is created AS a real user (who then owns it) or the folder lives in a Shared
// Drive (where files are owned by the drive, not the creator). See README "Drive storage
// quota / monthly sheet creation".
function getAuth(keyPath, impersonateUser) {
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    // Full drive scope (not drive.readonly) - creating each new month's spreadsheet from
    // the template requires write access, not just browsing.
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    ...(impersonateUser ? { clientOptions: { subject: impersonateUser } } : {}),
  });
}

function isStorageQuotaError(error) {
  return (
    (error.errors || []).some((e) => e.reason === 'storageQuotaExceeded') ||
    /storage quota/i.test(error.message || '')
  );
}

const DRIVE_LIST_DEFAULTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives',
};

// Lists the children of a folder, robust to the folder living in a shared drive. The
// combined 'allDrives' corpus returned NOTHING for the shared drive root in production on
// 2026-09-02 (run recording 2026-09-03) even though the folder had children - so when it
// comes back empty, retry scoped to the specific shared drive (corpora 'drive' + driveId,
// the documented way to list shared drive contents). A shared-drive ROOT's own id doubles
// as the driveId (they start with "0A"); for a folder deeper in a drive, its driveId is
// fetched. An empty result after both attempts is returned as-is - the caller decides
// what empty means.
async function listFolderChildren(drive, parentId, extraQ) {
  const q = `'${parentId}' in parents and trashed = false${extraQ ? ` and ${extraQ}` : ''}`;
  const base = { q, fields: 'files(id, name)', pageSize: 100 };

  let res = await drive.files.list({ ...base, ...DRIVE_LIST_DEFAULTS });
  let files = res.data.files || [];
  if (files.length) return files;

  let driveId = null;
  if (parentId.startsWith('0A')) {
    driveId = parentId;
  } else {
    try {
      const meta = await drive.files.get({ fileId: parentId, fields: 'driveId', supportsAllDrives: true });
      driveId = meta.data.driveId || null;
    } catch (err) {
      // Can't even read the parent's metadata - fall through and let the empty result
      // (and the caller's error message) surface the access problem.
    }
  }
  if (!driveId) return files;

  res = await drive.files.list({
    ...base,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'drive',
    driveId,
  });
  return res.data.files || [];
}

// The configured top folder doesn't hold monthly spreadsheets directly - it holds one
// subfolder per year (observed live: "Mix Sheets 26'" for 2026, "Mix Sheets 25'" for
// 2025 - note the trailing apostrophe and 2-digit year). Since 2026-09-02 the "top
// folder" is the root of the "Drive" shared drive. This finds that year's subfolder.
async function findYearSubfolderId(auth, topFolderId, twoDigitYear) {
  const drive = google.drive({ version: 'v3', auth });
  const yearRegex = new RegExp(`${twoDigitYear}'?$`);

  const folders = (
    await listFolderChildren(drive, topFolderId, `mimeType = 'application/vnd.google-apps.folder'`)
  ).filter((f) => yearRegex.test(f.name.trim()));
  if (folders.length === 1) return folders[0].id;
  if (folders.length > 1) {
    throw new Error(
      `Multiple year subfolders matched "${twoDigitYear}" under ${topFolderId}: ` +
        `${folders.map((f) => f.name).join(', ')} - ambiguous, needs a human.`
    );
  }

  // Nothing visible under the parent. The service account may still have access to the
  // year folder ITSELF without being able to list its parent (e.g. shared directly on the
  // subfolder while not being a member of the shared drive) - search everything visible
  // for a matching "Mix Sheets NN'" folder by name before giving up.
  const global = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name contains 'Mix Sheets'`,
    fields: 'files(id, name)',
    pageSize: 100,
    ...DRIVE_LIST_DEFAULTS,
  });
  const candidates = (global.data.files || []).filter((f) => yearRegex.test(f.name.trim()));
  if (candidates.length === 1) {
    console.log(
      `Year folder not visible under ${topFolderId} - using "${candidates[0].name}" ` +
        `(${candidates[0].id}) found by global name search instead. If this folder lives ` +
        `in a shared drive, add the service account (printed at the top of this log) as a ` +
        `MEMBER of that shared drive to fix the direct lookup.`
    );
    return candidates[0].id;
  }
  if (candidates.length > 1) {
    throw new Error(
      `No year subfolder visible under ${topFolderId}, and the global name search matched ` +
        `more than one candidate: ${candidates.map((f) => f.name).join(', ')} - ambiguous, needs a human.`
    );
  }

  throw new Error(
    `No year subfolder matching "${twoDigitYear}" found under folder ${topFolderId}, and ` +
      `no "Mix Sheets ${twoDigitYear}'" folder is visible to this service account anywhere. ` +
      `If the folder lives in a shared drive, the service account (its email is printed at ` +
      `the top of this log) must be added as a MEMBER of that shared drive (Manage members > ` +
      `Content manager) - a share on an individual subfolder is not enough to list the ` +
      `drive's root.`
  );
}

// Lists every spreadsheet in the given year subfolder whose name matches the given pattern
// (e.g. /July\s+2026/i). Does NOT throw on zero matches - callers decide what "missing"
// means (ensureMonthlySpreadsheet below creates one; other callers might want to just know).
async function listMonthlySpreadsheetMatches(auth, yearFolderId, namePattern) {
  const drive = google.drive({ version: 'v3', auth });
  // Uses the shared-drive-robust helper: a silently empty listing here wouldn't just fail
  // - ensureMonthlySpreadsheet would conclude the month's sheet doesn't exist and create a
  // DUPLICATE next to the invisible real one.
  const files = await listFolderChildren(
    drive,
    yearFolderId,
    `mimeType = 'application/vnd.google-apps.spreadsheet'`
  );
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

  let copyRes;
  try {
    copyRes = await drive.files.copy({
      fileId: templateId,
      supportsAllDrives: true,
      requestBody: { name: fileName, parents: [yearFolderId] },
    });
  } catch (error) {
    if (isStorageQuotaError(error)) {
      throw new Error(
        `Copying the template to create "${fileName}" failed with Google's ` +
          `"storage quota exceeded" error. This is NOT a full-disk problem: service ` +
          `accounts have 0 bytes of Drive storage (Google policy change, April 2025), so ` +
          `the bot can no longer OWN new files, and copying the template into a regular ` +
          `My Drive folder makes the bot the owner. Fix one of two ways - see README ` +
          `"Drive storage quota / monthly sheet creation": (1) move the Mix Sheets folder ` +
          `into a Google Workspace Shared Drive (files there are owned by the drive, no ` +
          `code change needed), or (2) set GOOGLE_IMPERSONATE_USER to a real Workspace ` +
          `user's email and grant the service account domain-wide delegation, so the copy ` +
          `is created as (and owned by) that user. Original error: ${error.message}`
      );
    }
    throw error;
  }
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
