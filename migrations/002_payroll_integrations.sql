CREATE TABLE IF NOT EXISTS public.time_clock_integrations (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  provider text NOT NULL DEFAULT 'northstar',
  api_key text,
  api_base_url text,
  location_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_integrations (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  provider text NOT NULL DEFAULT 'axios_engage',
  api_key text,
  company_identifier text,
  pay_period text NOT NULL DEFAULT 'biweekly'
    CHECK (pay_period IN ('weekly','biweekly','semimonthly')),
  payroll_check_day integer NOT NULL DEFAULT 1
    CHECK (payroll_check_day BETWEEN 0 AND 6),
  auto_check_enabled boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
