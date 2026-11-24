BEGIN;

-- Who a subscription is for: specific people (seats given one by one), a whole department,
-- or the whole organisation. Department subscriptions name the department in department_id.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'PEOPLE'
    CHECK (audience IN ('PEOPLE','DEPARTMENT','ORGANISATION'));

-- Existing rows that already name a department and have nobody assigned are department plans.
UPDATE subscriptions s SET audience = 'DEPARTMENT'
 WHERE s.department_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM subscription_assignments sa WHERE sa.subscription_id = s.id);

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_department_audience;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_department_audience
  CHECK (audience <> 'DEPARTMENT' OR department_id IS NOT NULL);

COMMIT;
