BEGIN;

-- Preventive maintenance (ROLES-AND-PAGES.md: Maintenance page, Reports "maintenance").
-- A schedule repeats a task for one asset every N days. Scheduling a whole subcategory
-- creates one schedule per asset, so every schedule has exactly one asset.
CREATE TABLE maintenance_schedules(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  interval_days int NOT NULL CHECK(interval_days BETWEEN 1 AND 3650),
  next_due date NOT NULL,
  assigned_to uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1 CHECK(version > 0)
);
CREATE INDEX maintenance_schedules_due ON maintenance_schedules(next_due) WHERE active;
CREATE INDEX maintenance_schedules_asset ON maintenance_schedules(asset_id);

-- One row per completed service: who did it, when, and what was found.
CREATE TABLE maintenance_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES maintenance_schedules(id) ON DELETE SET NULL,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES users(id),
  notes text CHECK(notes IS NULL OR length(notes) <= 2000)
);
CREATE INDEX maintenance_records_asset ON maintenance_records(asset_id, completed_at DESC);
CREATE INDEX maintenance_records_schedule ON maintenance_records(schedule_id, completed_at DESC);

COMMIT;
