BEGIN;
CREATE TABLE workflow_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_key text NOT NULL,user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('ASSIGNMENT','TICKET','FINANCE_REVIEW','FINANCE_RESULT')),
 entity_id uuid NOT NULL,title varchar(160) NOT NULL,message varchar(500) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(event_key,user_id)
);
CREATE INDEX workflow_notifications_inbox ON workflow_notifications(user_id,created_at DESC,id DESC);
CREATE TABLE workflow_notification_reads(notification_id uuid NOT NULL REFERENCES workflow_notifications(id),user_id uuid NOT NULL REFERENCES users(id),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(notification_id,user_id));
CREATE TRIGGER immutable_workflow_notifications BEFORE UPDATE OR DELETE ON workflow_notifications FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
