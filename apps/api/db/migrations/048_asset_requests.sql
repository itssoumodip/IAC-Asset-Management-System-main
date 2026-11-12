BEGIN;

-- Item requests (ROLES-AND-PAGES.md P4, approvals P15).
-- A person asks for items by subcategory and quantity; each line is decided by the lead of the
-- team that handles that subcategory, then marked fulfilled when the item is handed over.
CREATE TABLE asset_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  requester_id uuid NOT NULL REFERENCES users(id),
  needed_by date,
  remarks text CHECK(remarks IS NULL OR length(remarks) <= 1000),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_requests_requester ON asset_requests(requester_id, created_at DESC);

CREATE TABLE asset_request_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES asset_requests(id) ON DELETE CASCADE,
  asset_type_code text NOT NULL,
  category_code text NOT NULL,
  handling_team_id uuid REFERENCES teams(id),
  quantity int NOT NULL CHECK(quantity BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','APPROVED','REJECTED','FULFILLED','CANCELLED')),
  decision_note text CHECK(decision_note IS NULL OR length(decision_note) <= 1000),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  fulfilled_by uuid REFERENCES users(id),
  fulfilled_at timestamptz
);
CREATE INDEX asset_request_items_request ON asset_request_items(request_id);
CREATE INDEX asset_request_items_team_status ON asset_request_items(handling_team_id, status);

COMMIT;
