require('dotenv').config();
const { chromium } = require('playwright');

const { TECHS, shouldReduceJob } = require('./config');
const { computeMixSheetTarget, cellA1 } = require('./mixSheetTarget');
const { login, getTechDayJobs } = require('./serviceAutopilot');
const {
  getAuth,
  findYearSubfolderId,
  findMonthlySpreadsheetId,
  findSheetTabTitle,
  writeCellValue,
} = require('./googleSheets');
const { sendRunSummaryEmail } = require('./notify');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function computeReducedTotal(jobs) {
  let total = 0;
  let reduced = 0;
  const reductions = [];
  for (const job of jobs) {
    total += job.turfSqFt;
    if (shouldReduceJob(job.service, job.schedulingNote)) {
      reduced += job.turfSqFt;
      reductions.push(job);
    }
  }
  return { total, reduced, finalTotal: total - reduced, reductions };
}

function dateLabelFor(target) {
  return `${target.year}-${String(target.month).padStart(2, '0')}-${String(target.day).padStart(2, '0')}`;
}

// Processes every technician, tolerating a single tech's failure without aborting the
// others - a bad scrape for one tech shouldn't block the rest from being recorded, and the
// audit email needs to show exactly which tech(s) failed and why.
async function processTechs(page, target, { auth, spreadsheetId, sheetTitle, dryRun }) {
  const techResults = [];

  for (const tech of TECHS) {
    console.log(`\n${tech.name} (${tech.code}) - loading ${dateLabelFor(target)}...`);
    const row = target.row + tech.sheetRowOffset;
    const cellRange = cellA1({ ...target, row }, sheetTitle);

    let scraped;
    try {
      const jobs = await getTechDayJobs(page, {
        filterName: tech.filterName,
        year: target.year,
        month: target.month,
        day: target.day,
      });
      scraped = { jobs, ...computeReducedTotal(jobs) };
      console.log(
        `  ${scraped.jobs.length} jobs, raw total ${scraped.total.toFixed(2)}, reduced ` +
          `${scraped.reduced.toFixed(2)} (${scraped.reductions.length} jobs), final ${scraped.finalTotal.toFixed(2)}`
      );
    } catch (error) {
      console.error(`  FAILED to scrape/compute for ${tech.name}:`, error);
      techResults.push({ tech, row, cellRange, error });
      continue;
    }

    const result = { tech, row, cellRange, ...scraped };
    if (dryRun) {
      console.log(`  [DRY RUN] would write ${scraped.finalTotal.toFixed(2)} to ${cellRange}`);
    } else {
      try {
        await writeCellValue(auth, spreadsheetId, cellRange, scraped.finalTotal.toFixed(2));
        result.wrote = true;
        console.log(`  wrote ${scraped.finalTotal.toFixed(2)} to ${cellRange}`);
      } catch (writeError) {
        console.error(`  FAILED to write to ${cellRange}:`, writeError);
        result.writeError = writeError;
      }
    }
    techResults.push(result);
  }

  return techResults;
}

async function main() {
  const SA_EMAIL = requireEnv('SA_EMAIL');
  const SA_PASSWORD = requireEnv('SA_PASSWORD');
  const keyPath = requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  const folderId = requireEnv('MIX_SHEETS_FOLDER_ID');
  const timeZone = process.env.BUSINESS_TIMEZONE || 'America/Denver';
  const dryRun = process.env.DRY_RUN === 'true';
  const headless = process.env.HEADLESS !== 'false';

  let target;
  let techResults = [];
  let fatalError = null;

  try {
    target = computeMixSheetTarget(new Date(), timeZone);
    console.log(
      `Recording ${dateLabelFor(target)} -> ${target.spreadsheetNamePattern} / ` +
        `"${target.sheetTabNameNeedle}" / row ${target.row} col ${target.column}`
    );

    const auth = getAuth(keyPath);
    const yearFolderId = await findYearSubfolderId(auth, folderId, target.yearShort);
    const spreadsheetId = await findMonthlySpreadsheetId(auth, yearFolderId, target.spreadsheetNamePattern);
    const sheetTitle = await findSheetTabTitle(auth, spreadsheetId, target.sheetTabNameNeedle);
    console.log(`Spreadsheet: ${spreadsheetId}, tab: "${sheetTitle}"`);

    // See README "chrome.exe failing to launch on some Windows machines" - headless mode
    // uses the separate chromium-headless-shell build to work around a machine-level
    // Windows issue unrelated to this script.
    const browser = headless
      ? await chromium.launch({ headless: true, channel: 'chromium-headless-shell' })
      : await chromium.launch({ headless: false });

    try {
      const page = await browser.newPage();
      await login(page, SA_EMAIL, SA_PASSWORD);
      techResults = await processTechs(page, target, { auth, spreadsheetId, sheetTitle, dryRun });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Fatal error:', error);
    fatalError = error;
  }

  const anyFailure = Boolean(fatalError) || techResults.some((r) => r.error || r.writeError);
  try {
    await sendRunSummaryEmail({
      dateLabel: target ? dateLabelFor(target) : new Date().toISOString().slice(0, 10),
      techResults,
      fatalError,
    });
    console.log(`\nSummary email sent to ${process.env.NOTIFY_EMAIL_TO}.`);
  } catch (emailError) {
    console.error('Failed to send summary email:', emailError);
  }

  if (anyFailure) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
