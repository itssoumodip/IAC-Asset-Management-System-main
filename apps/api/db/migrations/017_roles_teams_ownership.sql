BEGIN;

-- Roles: widen the unnamed CHECK from 001 to the seven codes.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='roles'::regclass AND contype='c'
  LOOP
    EXECUTE format('ALTER TABLE roles DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE roles ADD CONSTRAINT roles_code_valid
  CHECK (code IN ('ADMIN','IT_ADMIN','EMPLOYEE','SUPER_ADMIN','FINANCE','EXECUTIVE'));
INSERT INTO roles(code) VALUES ('SUPER_ADMIN'),('FINANCE'),('EXECUTIVE') ON CONFLICT DO NOTHING;

CREATE TABLE teams(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2,5}$'),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  asset_code_prefix text NOT NULL UNIQUE CHECK (asset_code_prefix ~ '^[A-Z]{2,5}$'),
  requires_project boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
INSERT INTO teams(id,code,name,asset_code_prefix,requires_project) VALUES
  ('00000000-0000-4000-8000-000000000001','IT','IT','IT',false),
  ('00000000-0000-4000-8000-000000000002','ADM','Admin','ADM',false),
  ('00000000-0000-4000-8000-000000000003','PRJ','Projects','PRJ',true);

CREATE TABLE team_memberships(
  user_id uuid NOT NULL REFERENCES users(id),
  team_id uuid NOT NULL REFERENCES teams(id),
  level text NOT NULL CHECK (level IN ('LEAD','MEMBER')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,team_id)
);
CREATE INDEX team_memberships_team_level ON team_memberships(team_id,level);

CREATE TABLE projects(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(btrim(code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  funder text,
  grant_reference text,
  start_date date,
  end_date date,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE team_asset_counters(
  team_id uuid PRIMARY KEY REFERENCES teams(id),
  next_value bigint NOT NULL CHECK (next_value >= 1)
);

CREATE TABLE asset_type_policies(
  asset_type_code text PRIMARY KEY,
  requires_custodian boolean NOT NULL
);
INSERT INTO asset_type_policies(asset_type_code,requires_custodian) VALUES
  ('Printer',false),('Networking',false);

-- Counters: IT continues the existing sequence and any existing IAC-IT numbers.
CREATE FUNCTION it_counter_initial_value(seq_last bigint, seq_called boolean) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT greatest(
    CASE WHEN seq_called THEN seq_last+1 ELSE 1 END,
    (SELECT coalesce(max(substr(asset_code,8)::bigint),0)+1 FROM assets WHERE asset_code ~ '^IAC-IT-[0-9]{6}$'),
    1)
$$;
INSERT INTO team_asset_counters(team_id,next_value)
SELECT '00000000-0000-4000-8000-000000000001', it_counter_initial_value(last_value,is_called)
FROM asset_number_seq;
INSERT INTO team_asset_counters(team_id,next_value) VALUES
  ('00000000-0000-4000-8000-000000000002',1),
  ('00000000-0000-4000-8000-000000000003',1);

-- Assets: ownership columns and the widened asset_code format.
ALTER TABLE assets
  ADD COLUMN owning_team_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES teams(id),
  ADD COLUMN project_id uuid REFERENCES projects(id);
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='assets'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%asset_code%'
  LOOP
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE assets ADD CONSTRAINT assets_asset_code_format
  CHECK (asset_code ~ '^IAC-[A-Z]{2,5}-[0-9]{6}$');
CREATE INDEX assets_team_status ON assets(owning_team_id,status,id);
CREATE INDEX assets_project ON assets(project_id,id);
CREATE INDEX assets_location ON assets(location_id,id);

CREATE FUNCTION assets_code_prefix_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
  SELECT asset_code_prefix INTO p FROM teams WHERE id=NEW.owning_team_id;
  IF p IS NULL OR NEW.asset_code NOT LIKE 'IAC-'||p||'-%' THEN
    RAISE EXCEPTION 'asset code % does not match the owning team prefix', NEW.asset_code USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_code_prefix_check BEFORE INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_code_prefix_check();

CREATE FUNCTION teams_prefix_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_code_prefix IS DISTINCT FROM OLD.asset_code_prefix
     AND EXISTS(SELECT 1 FROM assets WHERE asset_code LIKE 'IAC-'||OLD.asset_code_prefix||'-%') THEN
    RAISE EXCEPTION 'team prefix % is in use by existing assets', OLD.asset_code_prefix USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_prefix_immutable BEFORE UPDATE OF asset_code_prefix ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_prefix_immutable();

-- Convert legacy grants.
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
ALTER TABLE user_roles ADD CONSTRAINT user_roles_no_legacy
  CHECK (role_code NOT IN ('ADMIN','IT_ADMIN'));

COMMIT;
