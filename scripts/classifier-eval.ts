/**
 * Classifier eval harness for src/ai/claude.ts::classifyIntent.
 *
 * Pins "today" to 2026-06-04 (UTC) by stubbing the global Date constructor
 * BEFORE the classifier module is loaded, then passes companyTimezone='UTC'
 * so the classifier's `new Intl.DateTimeFormat('en-CA', { timeZone })` returns
 * "2026-06-04" deterministically — regardless of wall-clock time.
 *
 * Run:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' \
 *     npx ts-node --skip-project scripts/classifier-eval.ts
 *
 * Optional flags:
 *   --runs=N    Run every case N times (default 1). Use 2+ to surface flips.
 *   --concurrency=N   Parallel API calls (default 4).
 *   --filter=substr   Only run cases whose group or message contains substr.
 */

import 'dotenv/config';

// ── Pin "today" before classifier module is loaded ───────────────────────────
const FIXED_TODAY_MS = Date.UTC(2026, 5, 4, 12, 0, 0); // 2026-06-04 12:00 UTC
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FIXED_TODAY_MS);
    } else if (args.length === 1) {
      super(args[0] as number | string | Date);
    } else {
      super(
        args[0] as number,
        args[1] as number,
        (args[2] as number) ?? 1,
        (args[3] as number) ?? 0,
        (args[4] as number) ?? 0,
        (args[5] as number) ?? 0,
        (args[6] as number) ?? 0,
      );
    }
  }
  static now(): number {
    return FIXED_TODAY_MS;
  }
}
(globalThis as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;

// ── Env fallbacks for keys the classifier doesn't actually exercise ──────────
function ensureEnv(key: string, fallback: string): void {
  if (!process.env[key]) process.env[key] = fallback;
}
ensureEnv('SUPABASE_URL', 'https://dummy.supabase.co');
ensureEnv('SUPABASE_SERVICE_ROLE_KEY', 'dummy');
ensureEnv('TWILIO_ACCOUNT_SID', 'dummy');
ensureEnv('TWILIO_AUTH_TOKEN', 'dummy');
ensureEnv('SENDGRID_API_KEY', 'dummy');
ensureEnv('SENDGRID_FROM_EMAIL', 'dummy@example.com');

const TIMEZONE = 'UTC';
const COMPANY_CONTEXT =
  'Company: Acme Pool & Cafe. Sender employee name: Alex (a server/lifeguard).';

// ── Case definitions ─────────────────────────────────────────────────────────

interface ExpectedExtraction {
  time_off_type?: 'full_day' | 'partial';
  period_label?: 'morning' | 'afternoon' | 'evening' | null;
  start_date?: string;
  end_date?: string;
  target_employee_name?: string;
}

interface EvalCase {
  id: string;
  group: string;
  message: string;
  expected_intent: readonly string[]; // any-of match
  expected_fields?: ExpectedExtraction;
}

const CASES: EvalCase[] = [
  // ── (a) the exact regression case ──────────────────────────────────────────
  {
    id: 'a1',
    group: 'a — regression case',
    message: "I'm busy the morning of June 21st. I can work at night though",
    expected_intent: ['submit_time_off'],
    expected_fields: {
      time_off_type: 'partial',
      period_label: 'morning',
      start_date: '2026-06-21',
      end_date: '2026-06-21',
    },
  },

  // ── (b) date-vs-recurring pairs (informal) ─────────────────────────────────
  {
    id: 'b1',
    group: 'b — date partial',
    message: 'cant work the morning of july 3',
    expected_intent: ['submit_time_off'],
    expected_fields: {
      time_off_type: 'partial',
      period_label: 'morning',
      start_date: '2026-07-03',
    },
  },
  {
    id: 'b2',
    group: 'b — recurring availability',
    message: 'i cant do tuesday mornings anymore',
    expected_intent: ['update_availability'],
  },
  {
    id: 'b3',
    group: 'b — date partial',
    message: 'im out the afternoon of june 15',
    expected_intent: ['submit_time_off'],
    expected_fields: {
      time_off_type: 'partial',
      period_label: 'afternoon',
      start_date: '2026-06-15',
    },
  },
  {
    id: 'b4',
    group: 'b — recurring availability',
    message: 'i cant do friday afternoons anymore',
    expected_intent: ['update_availability'],
  },
  {
    id: 'b5',
    group: 'b — date full',
    message: 'i need june 30 off',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day', start_date: '2026-06-30' },
  },
  {
    id: 'b6',
    group: 'b — recurring availability',
    message: 'take me off mondays for good',
    expected_intent: ['update_availability'],
  },

  // ── (c) TO full informal ───────────────────────────────────────────────────
  {
    id: 'c1',
    group: 'c — TO full informal',
    message: 'gimme june 20 off',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day', start_date: '2026-06-20' },
  },
  {
    id: 'c2',
    group: 'c — TO full informal',
    // "next friday" from Thu 2026-06-04 is reasonably either 2026-06-05 or 2026-06-12.
    // Don't pin the date — just assert intent + full-day.
    message: 'im out next friday',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day' },
  },

  // ── (d) TO partial informal ────────────────────────────────────────────────
  {
    id: 'd1',
    group: 'd — TO partial informal',
    message: 'gotta leave early friday',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'partial' },
  },
  {
    id: 'd2',
    group: 'd — TO partial informal',
    message: 'cant come in till noon on the 5th',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'partial', start_date: '2026-06-05' },
  },

  // ── (e) availability informal ──────────────────────────────────────────────
  {
    id: 'e1',
    group: 'e — availability informal',
    message: 'take me off thursday nights',
    expected_intent: ['update_availability'],
  },
  {
    id: 'e2',
    group: 'e — availability informal',
    message: 'no more weekend mornings',
    expected_intent: ['update_availability'],
  },

  // ── (f) swap ───────────────────────────────────────────────────────────────
  {
    id: 'f1',
    group: 'f — swap',
    message: 'can someone cover my sat shift',
    expected_intent: ['initiate_swap'],
  },
  {
    id: 'f2',
    group: 'f — swap',
    message: 'trade shifts w mia saturday',
    expected_intent: ['initiate_swap'],
    expected_fields: { target_employee_name: 'Mia' },
  },

  // ── (g) emergency ──────────────────────────────────────────────────────────
  {
    id: 'g1',
    group: 'g — emergency',
    message: 'im sick cant make it today',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day', start_date: '2026-06-04' },
  },

  // ── (h) query ──────────────────────────────────────────────────────────────
  {
    id: 'h1',
    group: 'h — query',
    message: 'what days am i off',
    expected_intent: ['query_my_time_off'],
  },
  {
    id: 'h2',
    group: 'h — query',
    // "am i working this weekend" is operational ("when am I scheduled?"),
    // accept either operational_query or query_my_time_off.
    message: 'am i working this weekend',
    expected_intent: ['operational_query', 'query_my_time_off'],
  },

  // ── (i) confirm/deny informal — ambiguous without context; accept multiple ─
  {
    id: 'i1',
    group: 'i — confirm/deny',
    message: 'yeah',
    expected_intent: ['respond_swap_accept', 'general_question', 'unknown'],
  },
  {
    id: 'i2',
    group: 'i — confirm/deny',
    message: 'nah',
    expected_intent: ['respond_swap_decline', 'general_question', 'unknown'],
  },
  {
    id: 'i3',
    group: 'i — confirm/deny',
    message: 'no wait',
    expected_intent: ['respond_swap_decline', 'general_question', 'unknown'],
  },
  {
    id: 'i4',
    group: 'i — confirm/deny',
    message: 'never mind',
    expected_intent: ['respond_swap_decline', 'general_question', 'unknown'],
  },

  // ── (j) regression baseline — already-handled phrasings ────────────────────
  {
    id: 'j1',
    group: 'j — baseline',
    message: 'I need June 20 off please',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day', start_date: '2026-06-20' },
  },
  {
    id: 'j2',
    group: 'j — baseline',
    message: 'Can I have August 15th off?',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day', start_date: '2026-08-15' },
  },
  {
    id: 'j3',
    group: 'j — baseline',
    message: "I'd like to take Friday off",
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'full_day' },
  },
  {
    id: 'j4',
    group: 'j — baseline',
    message:
      'I want to change my availability — I can no longer work Wednesday evenings',
    expected_intent: ['update_availability'],
  },
  {
    id: 'j5',
    group: 'j — baseline',
    message: 'Can someone cover my shift on Saturday?',
    expected_intent: ['initiate_swap'],
  },
  {
    id: 'j6',
    group: 'j — baseline',
    message: "I'd like to swap my Friday shift with John",
    expected_intent: ['initiate_swap'],
    expected_fields: { target_employee_name: 'John' },
  },
  {
    id: 'j7',
    group: 'j — baseline',
    message: 'I accept the swap',
    expected_intent: ['respond_swap_accept'],
  },
  {
    id: 'j8',
    group: 'j — baseline',
    message: 'I decline the swap',
    expected_intent: ['respond_swap_decline'],
  },
  {
    id: 'j9',
    group: 'j — baseline',
    message: 'What time off do I have approved?',
    expected_intent: ['query_my_time_off'],
  },
  {
    id: 'j10',
    group: 'j — baseline',
    message: 'When is my next day off?',
    expected_intent: ['query_my_time_off'],
  },
  {
    id: 'j11',
    group: 'j — baseline',
    message: "What's the policy on calling out?",
    expected_intent: ['operational_query', 'general_question'],
  },
  {
    id: 'j12',
    group: 'j — baseline',
    message: 'What time does the pool open?',
    expected_intent: ['operational_query', 'general_question'],
  },
  {
    id: 'j13',
    group: 'j — baseline',
    message: 'I need Friday morning off',
    expected_intent: ['submit_time_off'],
    expected_fields: { time_off_type: 'partial', period_label: 'morning' },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

interface CaseResult {
  case: EvalCase;
  intent: string;
  confidence: string;
  extracted: Record<string, unknown>;
  passed: boolean;
  failures: string[];
}

function getFromDatesOrTop(
  extracted: Record<string, unknown>,
  field: 'start_date' | 'end_date' | 'time_off_type' | 'period_label',
): unknown {
  const dates = (extracted as { dates?: unknown }).dates;
  if (Array.isArray(dates) && dates.length > 0) {
    return (dates[0] as Record<string, unknown>)[field];
  }
  return (extracted as Record<string, unknown>)[field];
}

function checkFields(
  extracted: Record<string, unknown>,
  expected: ExpectedExtraction,
): string[] {
  const failures: string[] = [];
  for (const key of Object.keys(expected) as (keyof ExpectedExtraction)[]) {
    const expectedVal = expected[key];
    let actualVal: unknown;
    if (key === 'target_employee_name') {
      actualVal = (extracted as { target_employee_name?: unknown }).target_employee_name;
      if (typeof actualVal === 'string' && typeof expectedVal === 'string') {
        if (actualVal.toLowerCase() !== expectedVal.toLowerCase()) {
          failures.push(`${key}: expected "${expectedVal}", got "${actualVal}"`);
        }
        continue;
      }
      if (actualVal !== expectedVal) {
        failures.push(
          `${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
        );
      }
      continue;
    }
    actualVal = getFromDatesOrTop(extracted, key);
    if (actualVal !== expectedVal) {
      failures.push(
        `${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
      );
    }
  }
  return failures;
}

function parseArgs(): { runs: number; concurrency: number; filter: string | null } {
  const argv = process.argv.slice(2);
  let runs = 1;
  let concurrency = 2;
  let filter: string | null = null;
  for (const a of argv) {
    const m = a.match(/^--(runs|concurrency|filter)=(.+)$/);
    if (!m) continue;
    if (m[1] === 'runs') runs = Math.max(1, parseInt(m[2], 10));
    else if (m[1] === 'concurrency') concurrency = Math.max(1, parseInt(m[2], 10));
    else if (m[1] === 'filter') filter = m[2];
  }
  return { runs, concurrency, filter };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry classifier call on 429 (rate-limit). Honours retry-after header
// when present; falls back to exponential backoff. Distinct from the
// production withAnthropicRetry (which retries 500/503/529 only) so that
// the eval can probe under tight per-org limits without flaking.
async function classifyWithRateLimitRetry(
  classifyIntent: (
    m: string,
    r: 'employee' | 'manager' | 'quria_admin',
    ctx: string,
    tz: string,
  ) => Promise<{ intent: string; confidence: string; extracted: Record<string, unknown> }>,
  message: string,
): Promise<{ intent: string; confidence: string; extracted: Record<string, unknown> }> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await classifyIntent(message, 'employee', COMPANY_CONTEXT, TIMEZONE);
    } catch (e) {
      const err = e as { status?: number; headers?: Record<string, string> };
      if (err.status !== 429 || attempt === maxAttempts) throw e;
      const retryAfter = Number(err.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable');
}

async function runOne(
  classifyIntent: (
    m: string,
    r: 'employee' | 'manager' | 'quria_admin',
    ctx: string,
    tz: string,
  ) => Promise<{ intent: string; confidence: string; extracted: Record<string, unknown> }>,
  c: EvalCase,
): Promise<CaseResult> {
  try {
    const r = await classifyWithRateLimitRetry(classifyIntent, c.message);
    const intentOk = c.expected_intent.includes(r.intent);
    const failures: string[] = [];
    if (!intentOk) {
      failures.push(
        `intent: expected one of [${c.expected_intent.join('|')}], got "${r.intent}"`,
      );
    }
    if (intentOk && c.expected_fields) {
      failures.push(...checkFields(r.extracted, c.expected_fields));
    }
    return {
      case: c,
      intent: r.intent,
      confidence: r.confidence,
      extracted: r.extracted,
      passed: failures.length === 0,
      failures,
    };
  } catch (e) {
    return {
      case: c,
      intent: 'ERROR',
      confidence: 'low',
      extracted: {},
      passed: false,
      failures: [`exception: ${(e as Error).message}`],
    };
  }
}

async function runAll(
  classifyIntent: Parameters<typeof runOne>[0],
  cases: EvalCase[],
  concurrency: number,
): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= cases.length) return;
      results[i] = await runOne(classifyIntent, cases[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function fmtCase(r: CaseResult): string {
  const tag = r.passed ? 'PASS' : 'FAIL';
  const head = `[${tag}] ${r.case.id.padEnd(4)} (${r.case.group}) "${r.case.message}"`;
  if (r.passed) {
    return `${head}\n         → intent=${r.intent} confidence=${r.confidence}`;
  }
  return (
    `${head}\n` +
    `         → intent=${r.intent} confidence=${r.confidence}\n` +
    `         extracted=${JSON.stringify(r.extracted)}\n` +
    `         failures: ${r.failures.join('; ')}`
  );
}

async function main(): Promise<void> {
  const { runs, concurrency, filter } = parseArgs();
  const filtered = filter
    ? CASES.filter(
        c =>
          c.group.toLowerCase().includes(filter.toLowerCase()) ||
          c.message.toLowerCase().includes(filter.toLowerCase()) ||
          c.id.toLowerCase() === filter.toLowerCase(),
      )
    : CASES;

  // Defer the classifier import until after env fallbacks + FakeDate are set.
  const { classifyIntent } = await import('../src/ai/claude');

  console.log('═'.repeat(78));
  console.log('classifier-eval — fixed today=2026-06-04 (UTC)');
  console.log(
    `cases=${filtered.length}  runs=${runs}  concurrency=${concurrency}` +
      (filter ? `  filter="${filter}"` : ''),
  );
  console.log('═'.repeat(78));

  // Aggregate across runs: per-case pass-rate and flip detection.
  const allRunResults: CaseResult[][] = [];
  for (let r = 0; r < runs; r++) {
    if (runs > 1) console.log(`\n──── run ${r + 1}/${runs} ────`);
    const runResults = await runAll(classifyIntent, filtered, concurrency);
    allRunResults.push(runResults);
    for (const cr of runResults) {
      console.log('');
      console.log(fmtCase(cr));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78));
  console.log('Summary');
  console.log('═'.repeat(78));

  const byGroup: Record<string, { pass: number; total: number }> = {};
  const perCasePass: Record<string, number> = {};
  const perCaseIntents: Record<string, Set<string>> = {};
  for (const runRes of allRunResults) {
    for (const cr of runRes) {
      byGroup[cr.case.group] = byGroup[cr.case.group] ?? { pass: 0, total: 0 };
      byGroup[cr.case.group].total += 1;
      if (cr.passed) byGroup[cr.case.group].pass += 1;
      perCasePass[cr.case.id] = (perCasePass[cr.case.id] ?? 0) + (cr.passed ? 1 : 0);
      perCaseIntents[cr.case.id] = perCaseIntents[cr.case.id] ?? new Set<string>();
      perCaseIntents[cr.case.id].add(cr.intent);
    }
  }

  console.log('\nBy group:');
  for (const g of Object.keys(byGroup).sort()) {
    const { pass, total } = byGroup[g];
    console.log(`  ${g.padEnd(35)} ${pass}/${total}`);
  }

  if (runs > 1) {
    console.log('\nFlippy cases (intent varied across runs):');
    let anyFlip = false;
    for (const c of filtered) {
      const seen = perCaseIntents[c.id];
      if (seen && seen.size > 1) {
        anyFlip = true;
        console.log(
          `  ${c.id.padEnd(4)} "${c.message}" — saw: ${Array.from(seen).join(', ')}`,
        );
      }
    }
    if (!anyFlip) console.log('  (none)');
  }

  const totalRun = filtered.length * runs;
  const totalPass = Object.values(perCasePass).reduce((a, b) => a + b, 0);
  console.log('\n' + '─'.repeat(78));
  console.log(`Overall: ${totalPass}/${totalRun} pass (${(100 * totalPass / totalRun).toFixed(1)}%)`);
  console.log('═'.repeat(78));

  if (totalPass < totalRun) process.exit(1);
}

main().catch(e => {
  console.error('eval crashed:', e);
  process.exit(1);
});
