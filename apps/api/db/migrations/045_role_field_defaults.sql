BEGIN;

-- Default field permissions per role (ROLES-AND-PAGES.md P31, spec §7).
-- Each role gets a full row per asset field so the Field permissions page shows a saved state.
-- Existing rows are kept: anything a Super Admin already changed is not overwritten.
-- A person keeps a field if ANY of their roles (or team level) allows it; Super Admin is never limited.
WITH fields(f) AS (
  SELECT unnest(ARRAY[
    -- Identity
    'assetCode','category','assetType','description','manufacturer','model','serialNumber','barcode',
    -- Location
    'departmentId','locationId','owningTeamId','status',
    -- Condition
    'condition','riskLevel','dataWipeRequired','remarks','commentType',
    -- Warranty & AMC
    'warrantyExpiry','amcApplies','amcExpiry','lastLabelPrintedAt',
    -- Purchase
    'purchaseDate','purchaseCost','currency','residualValue','depreciationMethod','usefulLifeYears',
    'invoiceNumber','supplier',
    -- Insurance
    'insurancePolicyNumber','insuranceExpiry',
    -- Audit
    'lastAuditDate','nextAuditDate','assetOwner','financePending',
    -- Finance
    'financeStatus','financeRejectionReason'
  ])
),
-- hidden: fields the role cannot see. editable: fields the role can change (only if visible).
-- '*' in editable means every visible field.
rules(role, hidden, editable) AS (VALUES
  -- Leadership: sees everything, changes nothing.
  ('EXECUTIVE', ARRAY[]::text[], ARRAY[]::text[]),
  -- Finance: sees everything; owns cost, depreciation, invoice, insurance and the review outcome.
  ('FINANCE', ARRAY[]::text[], ARRAY[
    'purchaseDate','purchaseCost','currency','residualValue','depreciationMethod','usefulLifeYears',
    'invoiceNumber','supplier','insurancePolicyNumber','insuranceExpiry','financePending',
    'financeStatus','financeRejectionReason']),
  -- Team lead / member: run their team's assets; cost and the Finance outcome stay with Finance.
  ('TEAM_LEAD', ARRAY[]::text[], ARRAY[
    'category','assetType','description','manufacturer','model','serialNumber','barcode',
    'departmentId','locationId','owningTeamId','status','condition','riskLevel','dataWipeRequired',
    'remarks','commentType','warrantyExpiry','amcApplies','amcExpiry','purchaseDate','invoiceNumber',
    'supplier','insurancePolicyNumber','insuranceExpiry','lastAuditDate','nextAuditDate','assetOwner']),
  ('TEAM_MEMBER', ARRAY['financeRejectionReason']::text[], ARRAY[
    'category','assetType','description','manufacturer','model','serialNumber','barcode',
    'departmentId','locationId','status','condition','riskLevel','dataWipeRequired','remarks',
    'commentType','warrantyExpiry','amcApplies','amcExpiry','purchaseDate','invoiceNumber','supplier']),
  -- Store: stock, location and condition; no finance detail.
  ('STORE', ARRAY['residualValue','depreciationMethod','usefulLifeYears','insurancePolicyNumber',
    'insuranceExpiry','financePending','financeStatus','financeRejectionReason']::text[], ARRAY[
    'locationId','status','condition','remarks','commentType']),
  -- Technician: what is needed to repair; no money or audit detail.
  ('TECHNICIAN', ARRAY['purchaseDate','purchaseCost','currency','residualValue','depreciationMethod',
    'usefulLifeYears','invoiceNumber','supplier','insurancePolicyNumber','insuranceExpiry',
    'lastAuditDate','nextAuditDate','assetOwner','financePending','financeStatus',
    'financeRejectionReason']::text[], ARRAY[
    'condition','riskLevel','dataWipeRequired','remarks','commentType']),
  -- Auditor: verifies existence and condition; does not see price (plan open question, draft: no).
  ('AUDITOR', ARRAY['purchaseCost','currency','residualValue','depreciationMethod','usefulLifeYears',
    'financePending','financeStatus','financeRejectionReason']::text[], ARRAY[
    'condition','remarks','lastAuditDate','nextAuditDate']),
  -- Insurer: identity, where it is, what it cost and its cover (P24); read only.
  ('INSURER', ARRAY['dataWipeRequired','commentType','lastLabelPrintedAt','residualValue',
    'depreciationMethod','usefulLifeYears','invoiceNumber','supplier','lastAuditDate',
    'nextAuditDate','assetOwner','financePending','financeStatus','financeRejectionReason',
    'riskLevel','remarks']::text[], ARRAY[]::text[]),
  -- Procurement: purchase records (P25).
  ('PROCUREMENT', ARRAY['residualValue','depreciationMethod','usefulLifeYears',
    'insurancePolicyNumber','insuranceExpiry','lastAuditDate','nextAuditDate','financePending',
    'financeStatus','financeRejectionReason','dataWipeRequired']::text[], ARRAY[
    'purchaseDate','invoiceNumber','supplier']),
  -- Employee: their own equipment, without money, audit or risk detail; read only.
  ('EMPLOYEE', ARRAY['riskLevel','dataWipeRequired','commentType','lastLabelPrintedAt',
    'purchaseDate','purchaseCost','currency','residualValue','depreciationMethod','usefulLifeYears',
    'invoiceNumber','supplier','insurancePolicyNumber','insuranceExpiry','lastAuditDate',
    'nextAuditDate','assetOwner','financePending','financeStatus','financeRejectionReason']::text[],
    ARRAY[]::text[])
)
INSERT INTO role_field_permissions(role_code, field_name, can_view, can_edit)
SELECT r.role,
       fields.f,
       NOT (fields.f = ANY(r.hidden)),
       NOT (fields.f = ANY(r.hidden)) AND (fields.f = ANY(r.editable) OR '*' = ANY(r.editable))
  FROM rules r
  CROSS JOIN fields
  JOIN roles ro ON ro.code = r.role
ON CONFLICT (role_code, field_name) DO NOTHING;

COMMIT;
