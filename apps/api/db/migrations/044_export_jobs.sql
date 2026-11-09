-- Background exports: the worker builds the file, the requester downloads it for 7 days.
CREATE TABLE export_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('assets')),
  filters jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','READY','FAILED')),
  row_count int,
  content bytea,
  content_type text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX export_jobs_queue ON export_jobs(created_at) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX export_jobs_requester ON export_jobs(requested_by,created_at DESC);
CREATE INDEX export_jobs_expiry ON export_jobs(expires_at);
