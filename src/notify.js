const nodemailer = require('nodemailer');

function getTransport() {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    // 465 is implicit TLS from the start of the connection; 587 (and anything else) is
    // plaintext-then-STARTTLS. Getting this wrong on 587 causes an opaque connection error.
    secure: port === 465,
    auth: {
      user: process.env.SMTP_FROM_EMAIL,
      pass: process.env.SMTP_APP_PASSWORD,
    },
  });
}

function formatJob(job) {
  return `    - ${job.client || '(no client name)'} | ${job.service} | ${job.turfSqFt.toFixed(2)} sq ft`;
}

// techResults: array of { tech, jobs, total, reduced, finalTotal, reductions, row, cellRange,
//   wrote, writeError } - one entry per technician this run attempted to process.
// fatalError: set when the whole run failed before per-tech processing even started
//   (e.g. login failed, spreadsheet not found).
// createdSpreadsheetName: set when this run had to auto-create the month's spreadsheet
//   from the template because it didn't exist yet (e.g. first run of a new month).
function buildEmail({ dateLabel, techResults, fatalError, createdSpreadsheetName }) {
  const anyTechFailed = techResults.some((r) => r.error || r.writeError);
  const success = !fatalError && techResults.length > 0 && !anyTechFailed;
  const subject = `Mix Sheet Automation - ${success ? 'SUCCESS' : 'FAILURE'} - ${dateLabel}`;

  const lines = [];
  lines.push(`Mix Sheet automation run for ${dateLabel}`);
  lines.push('');

  if (createdSpreadsheetName) {
    lines.push(`Note: "${createdSpreadsheetName}" didn't exist yet, so it was created from the template.`);
    lines.push('');
  }

  if (fatalError) {
    lines.push(`FATAL ERROR - run stopped before any technician was processed:`);
    lines.push(`  ${fatalError.message || fatalError}`);
    lines.push('');
  }

  for (const r of techResults) {
    if (r.error) {
      lines.push(`${r.tech.name} (${r.tech.code}): FAILED while scraping/computing`);
      lines.push(`  Error: ${r.error.message || r.error}`);
      lines.push('');
      continue;
    }

    lines.push(
      `${r.tech.name} (${r.tech.code}): ${r.jobs.length} jobs, raw total ${r.total.toFixed(2)}, ` +
        `reduced ${r.reduced.toFixed(2)} sq ft across ${r.reductions.length} job(s), ` +
        `final ${r.finalTotal.toFixed(2)}`
    );
    lines.push(
      r.writeError
        ? `  FAILED to write to ${r.cellRange}: ${r.writeError.message || r.writeError}`
        : r.wrote
        ? `  Wrote ${r.finalTotal.toFixed(2)} to ${r.cellRange}`
        : `  [DRY RUN] would write ${r.finalTotal.toFixed(2)} to ${r.cellRange}`
    );

    if (r.reductions.length) {
      lines.push('  Sq ft removed from total (these jobs' + ' were subtracted):');
      r.reductions.forEach((job) => lines.push(formatJob(job)));
    } else {
      lines.push('  No jobs were reduced out of the total.');
    }
    lines.push('');
  }

  return { subject, text: lines.join('\n') };
}

async function sendRunSummaryEmail({ dateLabel, techResults, fatalError, createdSpreadsheetName }) {
  const { subject, text } = buildEmail({ dateLabel, techResults, fatalError, createdSpreadsheetName });
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM_EMAIL,
    to: process.env.NOTIFY_EMAIL_TO,
    subject,
    text,
  });
  return { subject, text };
}

module.exports = { sendRunSummaryEmail, buildEmail };
