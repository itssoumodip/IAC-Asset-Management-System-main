-- Apply only to this application's dedicated database, as its schema owner.
-- Creates a NOLOGIN permission role. Provision login credentials separately.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='iac_runtime') THEN CREATE ROLE iac_runtime NOLOGIN; END IF; END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO iac_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM iac_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO iac_runtime;
GRANT INSERT,UPDATE ON reference_values,departments,locations,users,assets,asset_photos,assignments,tickets,import_batches,import_rows,notification_groups,data_transfers TO iac_runtime;
GRANT INSERT,UPDATE,DELETE ON user_roles,approved_emails,sessions,auth_tokens,mfa_recovery_codes,mfa_enrollments,auth_rate_limits,notification_recipients,idempotency_keys TO iac_runtime;
GRANT INSERT ON audit_events,assignment_events,asset_movements,ticket_updates,email_attempts TO iac_runtime;
GRANT INSERT,UPDATE ON notification_outbox,email_deliveries TO iac_runtime;
GRANT INSERT,UPDATE,DELETE ON web_push_subscriptions TO iac_runtime;
GRANT INSERT ON in_app_announcements,in_app_announcement_reads TO iac_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO iac_runtime;
GRANT UPDATE ON SEQUENCE asset_number_seq TO iac_runtime;
GRANT INSERT ON ticket_photos,asset_label_prints TO iac_runtime;
-- No DELETE on assets/custody/tickets; no UPDATE/DELETE on immutable evidence.
-- Reapply explicit grants after new migrations. Do not grant schema ownership.

GRANT INSERT,UPDATE ON asset_finance TO iac_runtime;
GRANT INSERT ON asset_finance_events TO iac_runtime;

GRANT INSERT ON finance_invoice_evidence TO iac_runtime;

GRANT INSERT ON workflow_notifications,workflow_notification_reads TO iac_runtime;

GRANT INSERT,UPDATE ON stocktake_runs TO iac_runtime;
GRANT INSERT ON stocktake_expected,stocktake_observations TO iac_runtime;
