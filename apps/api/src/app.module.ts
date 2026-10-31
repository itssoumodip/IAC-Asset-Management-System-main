import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Db } from './db';
import { AuthController, AuthService } from './auth';
import { SessionGuard } from './security';
import { DomainController, DomainService } from './domain';
import { AssetPhotoController, AssetPhotoService } from './asset-photos';
import { ScanController, ScanService } from './scan';
import { LocationController, LocationService } from './locations';
import { AssetIdentifierController, AssetIdentifierService } from './asset-identifiers';
import { FieldPermissionController, FieldPermissionService } from './field-permissions';
import { LabelController, LabelService } from './labels';
import { DataTransferController, DataTransferService } from './data-transfers';
import { AdminDashboardController, AdminDashboardService } from './admin-dashboard';
import { ExecutiveDashboardController, ExecutiveDashboardService } from './executive-dashboard';
import { PushController, PushService } from './push';
import { NotificationsController, NotificationsService } from './notifications';
import { TeamController, TeamService } from './teams';
import { FinanceController, FinanceService } from './finance';
import { PeopleController, PeopleService } from './people';
import { CategoryController, CategoryService } from './categories';
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
    PushController,
    NotificationsController,
    TeamController,
    DirectoryController,
    UserPhotoController,
    PeopleController,
    LocationController,
    AssetIdentifierController,
    FieldPermissionController,
    CategoryController,
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
    PushService,
    NotificationsService,
    TeamService,
    PeopleService,
    LocationService,
    AssetIdentifierService,
    FieldPermissionService,
    CategoryService,
    ZohoSyncService,
    { provide: ZOHO_CLIENT, useFactory: zohoClientFromEnv },
  ],
})
export class AppModule {}
