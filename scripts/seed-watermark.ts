/**
 * Seed script for the Watermark demo company.
 * Run: npx ts-node --skip-project scripts/seed-watermark.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  // Resolve the Watermark demo company
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('id')
    .ilike('name', '%watermark%')
    .single();

  if (companyErr || !company) {
    console.error('Watermark company not found:', companyErr?.message);
    process.exit(1);
  }

  const companyId = (company as { id: string }).id;

  // Resolve employees by name
  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, name')
    .eq('company_id', companyId);

  if (empErr || !employees) {
    console.error('Failed to load employees:', empErr?.message);
    process.exit(1);
  }

  const byName = (name: string): string => {
    const emp = (employees as { id: string; name: string }[]).find(e => e.name === name);
    if (!emp) throw new Error(`Employee not found: ${name}`);
    return emp.id;
  };

  const requests = [
    // ── Decided requests (have Aegis reasoning) ──────────────────────────────
    {
      employee_id: byName('Aisha Johnson'),
      company_id: companyId,
      start_date: '2026-04-12',
      end_date: '2026-04-12',
      reason: 'Family obligation',
      status: 'approved',
      requested_at: '2026-04-08T10:14:00Z',
      decided_at: '2026-04-08T11:30:00Z',
      decided_by: 'manager',
      aegis_recommendation: 'approve',
      aegis_reasoning:
        'Coverage looks healthy on this date. Two other lifeguards are available and no other time off is approved. Recommend approval.',
    },
    {
      employee_id: byName('Lily Sanchez'),
      company_id: companyId,
      start_date: '2026-04-19',
      end_date: '2026-04-20',
      reason: 'Personal',
      status: 'denied',
      requested_at: '2026-04-14T09:02:00Z',
      decided_at: '2026-04-14T13:45:00Z',
      decided_by: 'manager',
      aegis_recommendation: 'deny',
      aegis_reasoning:
        'This date falls during a high traffic period with limited lifeguard availability. Approving would leave only one qualified lifeguard on the AM shift. Recommend denial.',
    },
    {
      employee_id: byName('Connor Reid'),
      company_id: companyId,
      start_date: '2026-04-26',
      end_date: '2026-04-27',
      reason: 'Weekend trip',
      status: 'approved',
      requested_at: '2026-04-21T15:30:00Z',
      decided_at: '2026-04-21T16:10:00Z',
      decided_by: 'manager',
      aegis_recommendation: 'approve',
      aegis_reasoning:
        'Weekend request with sufficient coverage. No staffing conflicts identified.',
    },
    // ── Pending requests (awaiting manager decision) ──────────────────────────
    {
      employee_id: byName('Marcus Thompson'),
      company_id: companyId,
      start_date: '2026-05-17',
      end_date: '2026-05-17',
      reason: 'Doctor appointment',
      status: 'pending',
      requested_at: '2026-05-09T08:45:00Z',
      decided_at: null,
      decided_by: null,
      aegis_recommendation: null,
      aegis_reasoning: null,
    },
    {
      employee_id: byName('Priya Nair'),
      company_id: companyId,
      start_date: '2026-05-22',
      end_date: '2026-05-23',
      reason: 'Family event',
      status: 'pending',
      requested_at: '2026-05-09T11:20:00Z',
      decided_at: null,
      decided_by: null,
      aegis_recommendation: null,
      aegis_reasoning: null,
    },
    {
      employee_id: byName('Derek Walsh'),
      company_id: companyId,
      start_date: '2026-06-02',
      end_date: '2026-06-06',
      reason: 'Vacation',
      status: 'pending',
      requested_at: '2026-05-09T14:05:00Z',
      decided_at: null,
      decided_by: null,
      aegis_recommendation: null,
      aegis_reasoning: null,
    },
  ];

  for (const req of requests) {
    const { error } = await supabase.from('time_off_requests').insert(req);
    if (error) {
      console.error(`Failed to insert request for employee ${req.employee_id}:`, error.message);
    } else {
      console.log(`Seeded time_off_request: employee ${req.employee_id} (${req.status})`);
    }
  }

  console.log('Watermark seed complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
