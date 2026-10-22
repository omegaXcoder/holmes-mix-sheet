// One entry per technician. `filterName` must exactly match the saved Dispatch Board
// view name in Service Autopilot (Select a Filter dropdown, top-left). `code` must match
// the tech's row label in column B of the Mix Sheet week tabs (cells look like
// "F02 (David)") - each tech's exact row is found at runtime by scanning for that code,
// so adding a tech here also requires their "F0N (Name)" row to exist in every day block
// of every week tab (see findTechDayRow in googleSheets.js and README "Mix Sheet layout").
const TECHS = [
  { code: 'F02', name: 'David', filterName: 'AUTOMATION - mix sheet review - David' },
  { code: 'F03', name: 'Brandt', filterName: 'AUTOMATION - mix sheet review - Brandt' },
  { code: 'F04', name: 'Harris', filterName: 'AUTOMATION - mix sheet review - Harris' },
  { code: 'F05', name: 'Nate', filterName: 'AUTOMATION - mix sheet review - Nate' },
  // Added 2026-09-09. Until an "F06 (Holdyn)" row is inserted into each day block of the
  // week tabs (and the template), Holdyn's runs fail loudly at row lookup while the other
  // techs keep recording normally.
  { code: 'F06', name: 'Holdyn', filterName: 'AUTOMATION - mix sheet review - Holdyn' },
];

// Services that reduce a job's turf sq ft out of the tech's daily total, confirmed against
// live Service Autopilot data on 2026-07-24. Matching is case-insensitive substring
// containment on the trimmed Service field, EXCEPT the two "lawn fert" entries which also
// require the job's scheduling note to mention "spring seeding".
//
// Locked-in rule (see conversation for the back-and-forth that got here):
//   - Reduce if the Service name does NOT contain "fert" at all (this covers Fungicide,
//     every "pest N of 7" visit, freeweedservice / freeweedservice(CR), freegrubcheck,
//     Flower Bed Pre-Emergent, and incidentally non-turf admin jobs like "Clean Van" /
//     "Truck Unload" - those are harmless no-ops since their CustomField1 is blank).
//   - Reduce "lawn fert 1 of 7" / "lawn fert 2 of 7" ONLY if the note mentions spring seeding.
//   - ALWAYS reduce if the Service name contains "free" - this takes priority over the
//     "fert" exclusion below. Needed because some free follow-up services are catalogued
//     under a category label that itself contains "fert" (e.g. "Lawn Fertilizing & Weed
//     Control:Free Follow Up Weed Control"), which would otherwise be wrongly kept in the
//     total just because of the category prefix, not the actual service performed.
//   - Never reduce any other service containing "fert" (regular Lawn fert 3-7 of 7,
//     Fert/Pest combos, Fert/Pest/Bait combos, etc).
const SPRING_SEEDING_FERT_VISITS = ['lawn fert 1 of 7', 'lawn fert 2 of 7'];
const SPRING_SEEDING_NOTE_PHRASE = 'spring seeding';

function shouldReduceJob(serviceName, schedulingNote) {
  const svc = (serviceName || '').trim().toLowerCase();
  const note = (schedulingNote || '').trim().toLowerCase();

  const seedingVisit = SPRING_SEEDING_FERT_VISITS.find((v) => svc.includes(v));
  if (seedingVisit) {
    return note.includes(SPRING_SEEDING_NOTE_PHRASE);
  }

  if (svc.includes('free')) return true;

  return !svc.includes('fert');
}

// Fall seeding rule (added 2026-10-11): a scheduling note mentioning "fall seeding 2026"
// (any 20xx year matches, so this survives into next season) means seeded area must come
// OUT of the mix even on jobs the rules above would keep (e.g. regular fert visits):
//   - If the note spells out a square footage, remove exactly that much. Two spellings
//     are recognized: a number tagged with units anywhere in the note ("5,000 sq ft",
//     "5000sqft", "3000 sf", "12.5k sq ft", "5000 square feet"), or a bare number
//     immediately after the phrase ("fall seeding 2026 - 5000", "fall seeding 2026: 5k").
//   - Otherwise, remove the job's entire square footage.
// Unrelated numbers elsewhere in the note (dates, "10/12", the year itself) deliberately
// do NOT count as a square footage - an untagged, non-adjacent number falls through to
// full removal, which errs on the side of keeping seeded turf out of the tank mix.
const FALL_SEEDING_REGEX = /fall\s+seeding\s+20\d{2}/i;

// Returns null if the note doesn't mention fall seeding, Infinity for "remove the whole
// job", or the specific sq ft the note calls out.
function fallSeedingReductionSqFt(schedulingNote) {
  const note = schedulingNote || '';
  if (!FALL_SEEDING_REGEX.test(note)) return null;

  const tagged = note.match(
    /([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:sq\.?\s*ft\.?|sqft|sf\b|square\s+f(?:ee|oo)t)/i
  );
  const afterPhrase = note.match(
    new RegExp(FALL_SEEDING_REGEX.source + String.raw`[\s:;,\-–]*([\d,]+(?:\.\d+)?)\s*(k)?\b`, 'i')
  );
  const m = tagged || afterPhrase;
  if (!m || !m[1]) return Infinity;
  const value = parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

// The single entry point for "how many sq ft does this job remove from the mix?".
// 0 = the whole job stays in the mix; anything between 0 and turfSqFt is a partial
// removal (only the fall seeding rule produces those); turfSqFt = full removal.
function jobReductionSqFt(serviceName, schedulingNote, turfSqFt) {
  if (shouldReduceJob(serviceName, schedulingNote)) return turfSqFt;
  const fallSeeding = fallSeedingReductionSqFt(schedulingNote);
  if (fallSeeding === null) return 0;
  return Math.min(fallSeeding, turfSqFt);
}

module.exports = {
  TECHS,
  shouldReduceJob,
  jobReductionSqFt,
  SPRING_SEEDING_NOTE_PHRASE,
};
