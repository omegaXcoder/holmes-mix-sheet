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

function statusText(r) {
  if (r.error) return 'FAILED (scrape)';
  if (r.writeError) return 'FAILED (write)';
  if (r.wrote) return 'Wrote';
  return 'Dry run';
}

// Plain-text body - kept as the email's text/plain part (fallback for clients that don't
// render HTML, and generally good practice to always include).
function buildText({ dateLabel, techResults, fatalError, createdSpreadsheetName }) {
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
      lines.push('  Sq ft removed from total (these jobs were subtracted):');
      r.reductions.forEach((job) => lines.push(formatJob(job)));
    } else {
      lines.push('  No jobs were reduced out of the total.');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TABLE_STYLE = 'border-collapse: collapse; width: 100%; margin-bottom: 8px; font-family: Arial, sans-serif; font-size: 13px;';
const TH_STYLE = 'border: 1px solid #ccc; padding: 6px 10px; background: #f0f0f0; text-align: left;';
const TD_STYLE = 'border: 1px solid #ccc; padding: 6px 10px; text-align: left;';
const TD_NUM_STYLE = TD_STYLE + ' text-align: right;';

function th(text) {
  return `<th style="${TH_STYLE}">${escapeHtml(text)}</th>`;
}
function td(text, numeric) {
  return `<td style="${numeric ? TD_NUM_STYLE : TD_STYLE}">${escapeHtml(text)}</td>`;
}

function buildReductionsTable(reductions) {
  if (!reductions.length) return '<p style="font-family: Arial, sans-serif; font-size: 13px; margin: 4px 0 16px;">No jobs were reduced out of the total.</p>';
  const rows = reductions
    .map(
      (job) =>
        `<tr>${td(job.client || '(no client name)')}${td(job.service)}${td(job.turfSqFt.toFixed(2), true)}</tr>`
    )
    .join('');
  return (
    `<table style="${TABLE_STYLE} margin-left: 20px; width: calc(100% - 20px);">` +
    `<thead><tr>${th('Client')}${th('Service')}${th('Sq Ft Removed')}</tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

// HTML body: one summary table (one row per tech) followed by, for each tech, a table of
// exactly which jobs got subtracted out of their total - the actual audit trail.
function buildHtml({ dateLabel, techResults, fatalError, createdSpreadsheetName }) {
  const parts = [];
  parts.push(`<div style="font-family: Arial, sans-serif; font-size: 14px;">`);
  parts.push(`<h2 style="font-size: 16px;">Mix Sheet automation run for ${escapeHtml(dateLabel)}</h2>`);

  if (createdSpreadsheetName) {
    parts.push(
      `<p><strong>Note:</strong> "${escapeHtml(createdSpreadsheetName)}" didn't exist yet, so it was created from the template.</p>`
    );
  }

  if (fatalError) {
    parts.push(
      `<p style="color: #b00020;"><strong>FATAL ERROR</strong> - run stopped before any technician was processed:<br>${escapeHtml(
        fatalError.message || fatalError
      )}</p>`
    );
  }

  if (techResults.length) {
    const summaryRows = techResults
      .map((r) => {
        if (r.error) {
          return `<tr>${td(`${r.tech.name} (${r.tech.code})`)}<td style="${TD_STYLE} color: #b00020;" colspan="6">FAILED while scraping/computing: ${escapeHtml(
            r.error.message || r.error
          )}</td></tr>`;
        }
        return (
          `<tr>` +
          `${td(`${r.tech.name} (${r.tech.code})`)}` +
          `${td(String(r.jobs.length), true)}` +
          `${td(r.total.toFixed(2), true)}` +
          `${td(r.reduced.toFixed(2), true)}` +
          `${td(r.finalTotal.toFixed(2), true)}` +
          `${td(r.cellRange)}` +
          `<td style="${TD_STYLE}${r.writeError ? ' color: #b00020;' : ''}">${escapeHtml(
            r.writeError ? `${statusText(r)}: ${r.writeError.message || r.writeError}` : statusText(r)
          )}</td>` +
          `</tr>`
        );
      })
      .join('');

    parts.push(
      `<table style="${TABLE_STYLE}"><thead><tr>` +
        `${th('Tech')}${th('Jobs')}${th('Raw Total')}${th('Reduced')}${th('Final')}${th('Cell')}${th('Status')}` +
        `</tr></thead><tbody>${summaryRows}</tbody></table>`
    );
  }

  for (const r of techResults) {
    if (r.error) continue;
    parts.push(
      `<h3 style="font-size: 14px; margin-bottom: 4px;">${escapeHtml(r.tech.name)} (${escapeHtml(
        r.tech.code
      )}) - sq ft removed from total</h3>`
    );
    parts.push(buildReductionsTable(r.reductions));
  }

  parts.push('</div>');
  return parts.join('\n');
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

  return {
    subject,
    text: buildText({ dateLabel, techResults, fatalError, createdSpreadsheetName }),
    html: buildHtml({ dateLabel, techResults, fatalError, createdSpreadsheetName }),
  };
}

async function sendRunSummaryEmail({ dateLabel, techResults, fatalError, createdSpreadsheetName }) {
  const { subject, text, html } = buildEmail({ dateLabel, techResults, fatalError, createdSpreadsheetName });
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM_EMAIL,
    to: process.env.NOTIFY_EMAIL_TO,
    subject,
    text,
    html,
  });
  return { subject, text, html };
}

module.exports = { sendRunSummaryEmail, buildEmail };
