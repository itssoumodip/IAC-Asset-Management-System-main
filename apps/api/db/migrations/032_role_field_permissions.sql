BEGIN;

CREATE TABLE role_field_permissions(
  role_code text NOT NULL REFERENCES roles(code),
  field_name text NOT NULL CHECK (field_name ~ '^[a-z][a-zA-Z0-9_]{1,79}$'),
  can_view boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_code, field_name)
);

INSERT INTO role_field_permissions(role_code,field_name,can_view,can_edit)
VALUES
  ('INSURER','description',true,false),
  ('INSURER','purchase_cost',true,false),
  ('INSURER','purchase_date',true,false)
ON CONFLICT DO NOTHING;

CREATE INDEX role_field_permissions_view
  ON role_field_permissions(role_code, can_view, field_name);

COMMIT;
