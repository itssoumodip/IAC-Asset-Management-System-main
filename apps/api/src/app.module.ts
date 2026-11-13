import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Db } from './db';
import { AuthController, AuthService } from './auth';
import { SessionGuard } from './security';
import { DomainController, DomainService } from './domain';
import { AssetPhotoController, AssetPhotoService } from './asset-photos';
import { ScanController, ScanService } from './scan';
import { AssetIdentifierController, AssetIdentifierService } from './asset-identifiers';
import { FieldPermissionController, FieldPermissionService } from './field-permissions';
import { LabelController, LabelService } from './labels';
import { DataTransferController, DataTransferService } from './data-transfers';
import { AdminDashboardController, AdminDashboardService } from './admin-dashboard';
import { ExecutiveDashboardController, ExecutiveDashboardService } from './executive-dashboard';
import { RoleFieldController, RoleFieldService } from './role-field';
import { LocationsController, LocationsService } from './locations';
import { CategoriesController, CategoriesService } from './categories';
import { InventoryController, InventoryService } from './inventory';
import { StoreController, StoreService } from './store';
import { VerificationController, VerificationService } from './verification';
import { DepreciationController, DepreciationService } from './depreciation';
import { ReportsController, ReportsService } from './reports';
import { InsuranceController, InsuranceService } from './insurance';
import { ProcurementController, ProcurementService } from './procurement';
import { ApprovalsController, ApprovalsService } from './approvals';
import { PushController, PushService } from './push';
import { NotificationsController, NotificationsService } from './notifications';
import { TeamController, TeamService } from './teams';
import { TransferController, TransferService } from './transfers';
import { FinanceController, FinanceService } from './finance';
import { AssignablePeopleController, PeopleController, PeopleService } from './people';
import { ExportJobsController, ExportJobsService } from './export-jobs';
import { MaintenanceController, MaintenanceService } from './maintenance';
import { RequestsController, RequestsService } from './requests';
import { CategoryController, CategoryService } from './categories';
import { ViewAsController } from './view-as';
import { InsightsController, InsightsService } from './insights';
import {
  DirectoryController,
  UserPhotoController,
  ZOHO_CLIENT,
  ZohoSyncService,
  zohoClientFromEnv,
} from './zoho';
@Module({
  controllers: [
    AuthController,
    FinanceController,
    DomainController,
    AssetPhotoController,
    ScanController,
    LabelController,
    DataTransferController,
    AdminDashboardController,
    ExecutiveDashboardController,
    RoleFieldController,
    LocationsController,
    CategoriesController,
    InventoryController,
    StoreController,
    VerificationController,
    DepreciationController,
    ReportsController,
    InsuranceController,
    ProcurementController,
    PushController,
    NotificationsController,
    TeamController,
    TransferController,
    DirectoryController,
    UserPhotoController,
    PeopleController,
    AssignablePeopleController,
    ApprovalsController,
    ExportJobsController,
    MaintenanceController,
    RequestsController,
    AssetIdentifierController,
    FieldPermissionController,
    CategoryController,
    ViewAsController,
    InsightsController,
  ],
  providers: [
    Db,
    AuthService,
    SessionGuard,
    DomainService,
    FinanceService,
    AssetPhotoService,
    ScanService,
    LabelService,
    DataTransferService,
    AdminDashboardService,
    ExecutiveDashboardService,
    RoleFieldService,
    LocationsService,
    CategoriesService,
    InventoryService,
    PushService,
    NotificationsService,
    TeamService,
    TransferService,
    PeopleService,
    StoreService,
    VerificationService,
    DepreciationService,
    ReportsService,
    InsuranceService,
    ProcurementService,
    ApprovalsService,
    ExportJobsService,
    MaintenanceService,
    RequestsService,
    AssetIdentifierService,
    FieldPermissionService,
    CategoryService,
    InsightsService,
    ZohoSyncService,
    { provide: ZOHO_CLIENT, useFactory: zohoClientFromEnv },
  ],
})
export class AppModule {}
