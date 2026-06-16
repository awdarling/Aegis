// Dev preview: render the Quria-branded manager emails to static HTML files so
// the look + voice can be eyeballed without sending anything or hitting the DB.
// Uses the real body-render functions (single source of truth), with fake URLs.
//
//   OUT_DIR=/tmp npx ts-node --skip-project scripts/preview-branded-email.ts
//
// Writes <OUT_DIR>/branded-time-off-sample.html (defaults to ./preview).

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { brandedEmailShell, quriaLogoDataUri, QURIA_LOGO_CID } from '../src/messaging/brand';
import { renderTimeOffManagerBodyHtml } from '../src/workflows/time-off-manager-email';
import { renderScheduleResultBodyHtml } from '../src/workflows/schedule-build-email';
import { htmlFromText } from '../src/messaging/email';

const HOMEBASE = process.env.HOMEBASE_URL ?? 'https://homebase-nine-phi.vercel.app';
const OUT_DIR = process.env.OUT_DIR ?? join(__dirname, '..', 'preview');
mkdirSync(OUT_DIR, { recursive: true });

// In a real email the logo is an inline `cid:` attachment; a browser preview
// can't resolve cid:, so swap it for an embedded data URI for the file preview.
const withPreviewLogo = (html: string): string =>
  html.split(`cid:${QURIA_LOGO_CID}`).join(quriaLogoDataUri());

// ── Time-off manager email (rich workflow email) ──────────────────────────────
const toBody = renderTimeOffManagerBodyHtml({
  employeeName: 'Shmubba Sploosh',
  managerName: 'Carolyn Ringler',
  tor: {
    id: 'demo',
    employee_id: 'e1',
    start_date: '2026-06-20',
    end_date: '2026-06-22',
    time_off_type: 'full_day',
    reason: 'Out of town for a family wedding',
    status: 'pending',
    partial_days: null,
  } as never,
  dateRange: 'Jun 20–22, 2026',
  approveUrl: `${HOMEBASE}/a/approve-demo`,
  denyUrl: `${HOMEBASE}/a/deny-demo`,
  homebaseUrl: HOMEBASE,
  policyLines: [
    'Notice period: Submitted 4 days before start date, less than the 7-day minimum.',
  ],
  simulation: {
    coverage_gaps: [
      { date: '2026-06-20', shift_name: 'Afternoon', role: 'Lifeguard', shortfall: 1 },
    ],
  } as never,
  recommendation: {
    type: 'neutral',
    reasoning:
      'Saturday afternoon gets a little thin if this goes through, but it works if you slide one guard over from the morning. Your call.',
  },
});
const toHtml = brandedEmailShell({
  bodyHtml: toBody,
  companyName: 'Watermark Country Club',
  preheader: 'Time-off request from Shmubba Sploosh — Jun 20–22, 2026',
});
writeFileSync(join(OUT_DIR, 'branded-time-off-sample.html'), withPreviewLogo(toHtml));

// ── Manager build/distribute report (rich action email) ──────────────────────
const distBody = renderScheduleResultBodyHtml({
  companyName: 'Watermark Country Club',
  managerName: 'Carolyn Ringler',
  weekRange: 'Jun 22–28, 2026',
  cov: {
    rate: 96.4,
    filled: 53,
    required: 55,
    badgeLabel: '96% covered',
    badgeBg: '#0a2e1a',
    badgeFg: '#4ade80',
  },
  result: {
    gaps: [],
    flagged_issues: [],
    closed_dates: [],
    shift_override_mismatches: [],
  } as never,
  hoursRows: [
    { employee_id: '1', name: 'Lucas Vermeer', role: 'Headguard', hours: 15.3, max_hours: 40, pct_of_max: 38 },
    { employee_id: '2', name: 'Erin Berigan', role: 'Headguard', hours: 10.8, max_hours: 40, pct_of_max: 27 },
    { employee_id: '3', name: 'Audrey Rook', role: 'Lifeguard', hours: 22.5, max_hours: 28, pct_of_max: 80 },
  ],
  wages: { total_estimated: 4820, missing_wages: [] } as never,
  distributeUrl: `${HOMEBASE}/a/distribute-demo`,
  homebaseUrl: HOMEBASE,
});
const distHtml = brandedEmailShell({
  bodyHtml: distBody,
  companyName: 'Watermark Country Club',
  preheader: 'Your schedule for Jun 22–28 is built and ready to send',
});
writeFileSync(join(OUT_DIR, 'branded-distribute-sample.html'), withPreviewLogo(distHtml));

// ── Simple reply (the shared htmlFromText shell) ──────────────────────────────
const simple = htmlFromText(
  "Hi Carolyn,\n\nAll set — I've put Marcus down for the Saturday morning Lifeguard shift and let him know. " +
    'Your schedule for the week is unchanged otherwise.\n\nWant me to send the updated day out to the team?'
);
writeFileSync(join(OUT_DIR, 'branded-simple-reply-sample.html'), withPreviewLogo(simple));

console.log(`Wrote previews to ${OUT_DIR}`);
