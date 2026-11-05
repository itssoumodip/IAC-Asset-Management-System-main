BEGIN;

-- Role × asset field permissions (ROLES-AND-PAGES.md P31, §7)
-- Super Admin configures which asset fields each role may see and edit.
CREATE TABLE role_field_permissions (
  role_code text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  field_name text NOT NULL CHECK(field_name ~ '^[a-z][a-zA-Z0-9_]{1,79}$'),
  can_view boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_code, field_name)
);

CREATE INDEX role_field_permissions_view ON role_field_permissions(role_code, can_view, field_name);

COMMIT;
