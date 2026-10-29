export type Role = 'ADMIN' | 'EMPLOYEE' | 'IT_ADMIN' | 'FINANCE' | 'EXECUTIVE';
export type Page<T> = { items: T[]; nextCursor: string | null; totalCount?: number };
export interface User {
  id: string;
  email: string;
  pendingEmail?: string | null;
  displayName: string;
  designation?: string | null;
  departmentId?: string | null;
  department?: string | null;
  roles: Role[];
  state: 'INVITED' | 'ACTIVE' | 'DISABLED';
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
  currentAssignment?: Assignment | null;
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
export interface References {
  values: ReferenceValue[];
  departments: DepartmentReference[];
  locations: LocationReference[];
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
