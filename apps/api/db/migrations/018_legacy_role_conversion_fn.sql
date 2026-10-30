BEGIN;
-- Legacy ADMIN / IT_ADMIN grants -> SUPER_ADMIN / (EMPLOYEE + IT team MEMBER).
-- Migration 017 performed this inline; the function makes the conversion testable.
-- Idempotent: only users still holding a legacy role are touched and audited.
CREATE OR REPLACE FUNCTION convert_legacy_roles() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(actor_kind,entity_type,entity_id,action,changes,request_id)
  SELECT 'SYSTEM','user',g.user_id,'ROLE_MODEL_MIGRATED',
    jsonb_build_object('from',g.old_roles,
      'to',(SELECT coalesce(jsonb_agg(r ORDER BY r),'[]'::jsonb) FROM (
        SELECT 'SUPER_ADMIN' r WHERE g.old_roles ? 'ADMIN'
        UNION SELECT 'EMPLOYEE' WHERE g.old_roles ? 'IT_ADMIN'
        UNION SELECT 'IT:MEMBER' WHERE g.old_roles ? 'IT_ADMIN') x)),
    gen_random_uuid()
  FROM (SELECT user_id, jsonb_agg(role_code ORDER BY role_code) old_roles
        FROM user_roles WHERE role_code IN ('ADMIN','IT_ADMIN') GROUP BY user_id) g;
  INSERT INTO user_roles(user_id,role_code)
    SELECT user_id,'SUPER_ADMIN' FROM user_roles WHERE role_code='ADMIN' ON CONFLICT DO NOTHING;
  INSERT INTO team_memberships(user_id,team_id,level)
    SELECT user_id,'00000000-0000-4000-8000-000000000001','MEMBER' FROM user_roles WHERE role_code='IT_ADMIN' ON CONFLICT DO NOTHING;
  INSERT INTO user_roles(user_id,role_code)
    SELECT user_id,'EMPLOYEE' FROM user_roles WHERE role_code='IT_ADMIN' ON CONFLICT DO NOTHING;
  DELETE FROM user_roles WHERE role_code IN ('ADMIN','IT_ADMIN');
END $$;
COMMIT;
