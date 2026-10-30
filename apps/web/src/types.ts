export type Role = 'SUPER_ADMIN' | 'FINANCE' | 'EXECUTIVE' | 'EMPLOYEE';
export type Action =
  | 'asset.view_all'
  | 'asset.view_private'
  | 'asset.create'
  | 'asset.edit'
  | 'asset.custody'
  | 'asset.retire'
  | 'asset.import'
  | 'asset.label'
  | 'asset.photo'
  | 'asset.finance_edit'
  | 'asset.change_team'
  | 'team.manage_members'
  | 'ticket.work'
  | 'announcement.send'
  | 'report.view'
  | 'system.admin';
export interface TeamMembership {
  teamId: string;
  teamCode: string;
  level: 'LEAD' | 'MEMBER';
}
export interface Capabilities {
  global: Action[];
  teams: Record<string, Action[]>;
}
export type Page<T> = { items: T[]; nextCursor: string | null; totalCount?: number };
export interface AssignablePerson {
  id: string;
  displayName: string;
  email: string;
  employeeCode: string | null;
  designation: string | null;
  department: string | null;
  state: 'ACTIVE' | 'DIRECTORY';
  hasPhoto: boolean;
}
export interface User {
  id: string;
  email: string;
  pendingEmail?: string | null;
  displayName: string;
  designation?: string | null;
  departmentId?: string | null;
  department?: string | null;
  managerName?: string | null;
  roles: Role[];
  teams: TeamMembership[];
  capabilities: Capabilities;
  state: 'INVITED' | 'ACTIVE' | 'DISABLED' | 'DIRECTORY';
  hasPhoto?: boolean;
  emailVerifiedAt: string | null;
  portalAcceptedAt: string | null;
  portalNoticeVersion?: string;
  currentNoticeVersion?: string;
  version: number;
  mfaRequired?: boolean;
  mfaEnrolled?: boolean;
  enrollmentOnly?: boolean;
  mfaEnrollmentRequired?: boolean;
}
export interface Assignment {
  id: string;
  assetId?: string;
  userId?: string;
  employeeName?: string;
  employeeDesignation?: string | null;
  employeeDepartment?: string | null;
  version: number;
  acknowledgement: 'PENDING' | 'ACCEPTED' | 'DISPUTED';
  assignedAt?: string;
  acknowledgedAt?: string;
  note?: string;
}
export interface Asset {
  id: string;
  assetCode: string;
  description: string;
  category: string;
  assetType?: string;
  owningTeamId?: string | null;
  projectId?: string | null;
  status: string;
  version: number;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  barcode?: string;
  configuration?: string;
  graphics?: string;
  ownershipType?: string;
  departmentId?: string;
  locationId?: string;
  condition?: string;
  riskLevel?: string;
  warrantyExpiry?: string | null;
  amcApplies?: boolean;
  amcExpiry?: string | null;
  purchaseDate?: string;
  purchaseCost?: string | null;
  residualValue?: string | null;
  invoiceNumber?: string;
  supplier?: string;
  insurancePolicyNumber?: string;
  insuranceExpiry?: string;
  nextAuditDate?: string;
  lastAuditDate?: string;
  lastLabelPrintedAt?: string | null;
  remarks?: string;
  financePending?: boolean;
  financeStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  financeRejectionReason?: string | null;
  currentAssignment?: Assignment | null;
  kitParts?: { id: string; assetCode: string; description: string; assetType?: string }[];
  kitParent?: { id: string; assetCode: string } | null;
  timeline?: TimelineEvent[];
  [key: string]: unknown;
}
export interface TimelineEvent {
  id: string;
  createdAt: string;
  kind?: string;
  type?: string;
  summary?: string;
  body?: string;
  oldStatus?: string | null;
  newStatus?: string | null;
  visibility?: 'PUBLIC' | 'INTERNAL';
  authorName?: string;
}
export interface Ticket {
  id: string;
  ticketNumber: number;
  subject: string;
  description?: string;
  category?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED';
  version: number;
  assetId?: string | null;
  reporterId?: string;
  ownerId?: string | null;
  teamId?: string;
  createdAt?: string;
  updatedAt?: string;
  resolution?: string;
  photoCount?: number;
  updates?: TimelineEvent[];
}
export interface ReferenceValue {
  kind: string;
  code: string;
  label: string;
  active: boolean;
  version: number;
}
export interface DepartmentReference {
  id: string;
  name: string;
  code: string;
  active: boolean;
  version: number;
}
export interface LocationReference {
  id: string;
  code: string;
  site?: string | null;
  building?: string | null;
  floor?: string | null;
  room?: string | null;
  name?: string;
  active: boolean;
  version: number;
}
export interface TeamReference {
  id: string;
  code: string;
  name: string;
  assetCodePrefix: string;
  requiresProject: boolean;
  active: boolean;
  version: number;
  prefixInUse: boolean;
}
export interface ProjectReference {
  id: string;
  code: string;
  name: string;
  funder: string | null;
  grantReference: string | null;
  startDate: string;
  endDate: string | null;
  active: boolean;
  version: number;
}
export interface AssetTypePolicy {
  assetTypeCode: string;
  requiresCustodian: boolean;
}
export interface References {
  values: ReferenceValue[];
  departments: DepartmentReference[];
  locations: LocationReference[];
  teams?: TeamReference[];
  projects?: ProjectReference[];
  assetTypePolicies?: AssetTypePolicy[];
  ticketCategoryTeams?: { categoryCode: string; teamId: string }[];
}
export interface MasterKind {
  kind: string;
  label: string;
  mode: 'EDITABLE' | 'FIXED';
  allowCreate?: boolean;
  allowDeactivate?: boolean;
  description: string;
}
export interface MasterData extends References {
  kinds: MasterKind[];
}
export interface Dashboard {
  role?: string;
  assetCounts?: Record<string, number>;
  openTickets?: number;
  pendingAcknowledgements?: number;
  quarantinedRows?: number;
  unassignedTickets?: number;
  inProgressTickets?: number;
  assignedAssets?: number;
  unknownCounts?: Record<string, number>;
  [key: string]: unknown;
}
export interface ImportBatch {
  id: string;
  version: number;
  state: 'STAGED' | 'REVIEWED' | 'COMMITTED';
  total?: number;
  accepted?: number;
  quarantined?: number;
  issues?: { rowNumber: number; code: string; message: string }[];
  rows?: {
    rowNumber: number;
    state?: string;
    issues?: unknown;
    normalizedFields?: unknown;
    rawFields?: Record<string, unknown>;
  }[];
}
export interface ScanView {
  id: string;
  assetCode: string;
  category: string;
  assetType: string;
  manufacturer: string | null;
  model: string | null;
  department: string | null;
  custodian: {
    name: string;
    designation: string | null;
    department: string | null;
    acknowledgement: string;
    assignedAt: string;
  } | null;
  location: { site: string; floor: string | null; room: string | null } | null;
  status: string;
  hasPhoto: boolean;
  reportable: boolean;
  canViewFull: boolean;
}
export interface ProposedField {
  value: string;
  confidence: number;
}
export interface InvoiceMeta {
  id: string;
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  size: number;
  originalName: string;
  uploadedAt: string;
  extractionState: 'PENDING' | 'DONE' | 'FAILED';
  extractionError: string | null;
  fields: Partial<
    Record<'supplier' | 'invoiceNumber' | 'invoiceDate' | 'totalAmount' | 'gstin', ProposedField>
  >;
  assetIds: string[];
}
export interface FinanceQueueItem {
  id: string;
  assetCode: string;
  description: string;
  category: string;
  owningTeamId: string;
  teamCode: string;
  projectId: string | null;
  financeStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  financeRejectionReason: string | null;
  supplier: string | null;
  invoiceNumber: string | null;
  purchaseDate: string | null;
  purchaseCost: string | null;
  invoiceId: string | null;
  invoiceState: 'PENDING' | 'DONE' | 'FAILED' | null;
}
