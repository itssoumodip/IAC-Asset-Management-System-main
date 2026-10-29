BEGIN;
ALTER TABLE workflow_notifications ADD CONSTRAINT workflow_notification_identity UNIQUE(id,user_id);
ALTER TABLE workflow_notification_reads ADD CONSTRAINT workflow_read_owner FOREIGN KEY(notification_id,user_id) REFERENCES workflow_notifications(id,user_id);
COMMIT;
