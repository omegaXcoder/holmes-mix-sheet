// One entry per technician. `filterName` must exactly match the saved Dispatch Board
// view name in Service Autopilot (Select a Filter dropdown, top-left). `sheetRowOffset`
// is this tech's row position (0-indexed) within each day's 4-row block in the Mix Sheet
// "Wk/N Mix" tabs - see README "Mix Sheet layout" for how that maps to real rows.
const TECHS = [
  { code: 'F02', name: 'David', filterName: 'AUTOMATION - mix sheet review - David', sheetRowOffset: 0 },
  { code: 'F03', name: 'Brandt', filterName: 'AUTOMATION - mix sheet review - Brandt', sheetRowOffset: 1 },
  { code: 'F04', name: 'Harris', filterName: 'AUTOMATION - mix sheet review - Harris', sheetRowOffset: 2 },
  { code: 'F05', name: 'Nate', filterName: 'AUTOMATION - mix sheet review - Nate', sheetRowOffset: 3 },
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

  return !svc.includes('fert');
}

module.exports = {
  TECHS,
  shouldReduceJob,
  SPRING_SEEDING_NOTE_PHRASE,
};
