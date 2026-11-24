BEGIN;

-- Subscriptions: software, AI tools, cloud services and anything else paid for on a cycle.
-- Added and managed by the IT team (enforced in the API). Each subscription can be given to
-- people (one row per person per period); ending a person's access keeps the row as history.

CREATE SEQUENCE IF NOT EXISTS subscription_number_seq;

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_code text NOT NULL UNIQUE
    DEFAULT ('SUB-' || lpad(nextval('subscription_number_seq')::text, 6, '0')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  vendor text CHECK (vendor IS NULL OR length(btrim(vendor)) BETWEEN 1 AND 150),
  category text NOT NULL,
  plan text CHECK (plan IS NULL OR length(btrim(plan)) BETWEEN 1 AND 150),
  billing_cycle text NOT NULL DEFAULT 'MONTHLY'
    CHECK (billing_cycle IN ('MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY','ONE_TIME','FREE')),
  -- Price for one billing cycle of the whole plan (not per seat).
  cost numeric(14,2) CHECK (cost IS NULL OR cost >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  -- Seats the plan allows; NULL means not limited.
  seats_total integer CHECK (seats_total IS NULL OR seats_total > 0),
  start_date date,
  renewal_date date,
  auto_renew boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL','ACTIVE','CANCELLED','EXPIRED')),
  account_email text CHECK (account_email IS NULL OR length(btrim(account_email)) BETWEEN 3 AND 254),
  website text CHECK (website IS NULL OR length(btrim(website)) BETWEEN 3 AND 500),
  payment_method text CHECK (payment_method IS NULL OR length(btrim(payment_method)) BETWEEN 1 AND 150),
  department_id uuid REFERENCES departments(id),
  owning_team_id uuid NOT NULL REFERENCES teams(id),
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (renewal_date IS NULL OR start_date IS NULL OR renewal_date >= start_date)
);
CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS subscriptions_renewal ON subscriptions(renewal_date);
CREATE INDEX IF NOT EXISTS subscriptions_category ON subscriptions(category);

CREATE TABLE IF NOT EXISTS subscription_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES users(id),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id),
  end_note text CHECK (end_note IS NULL OR length(end_note) <= 1000),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
-- One open seat per person per subscription.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_assignments_open
  ON subscription_assignments(subscription_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS subscription_assignments_user
  ON subscription_assignments(user_id) WHERE ended_at IS NULL;

-- Subscription types, editable like other reference lists.
INSERT INTO reference_values(kind, code, label) VALUES
  ('SUBSCRIPTION_CATEGORY', 'AI tool', 'AI tool'),
  ('SUBSCRIPTION_CATEGORY', 'Software', 'Software'),
  ('SUBSCRIPTION_CATEGORY', 'Productivity & office', 'Productivity & office'),
  ('SUBSCRIPTION_CATEGORY', 'Design & media', 'Design & media'),
  ('SUBSCRIPTION_CATEGORY', 'Communication', 'Communication'),
  ('SUBSCRIPTION_CATEGORY', 'Cloud & hosting', 'Cloud & hosting'),
  ('SUBSCRIPTION_CATEGORY', 'Domain & email', 'Domain & email'),
  ('SUBSCRIPTION_CATEGORY', 'Security & antivirus', 'Security & antivirus'),
  ('SUBSCRIPTION_CATEGORY', 'Learning', 'Learning'),
  ('SUBSCRIPTION_CATEGORY', 'Other', 'Other')
ON CONFLICT (kind, code) DO NOTHING;

COMMIT;
