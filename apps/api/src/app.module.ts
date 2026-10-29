import { LifecycleController, LifecycleService } from './lifecycle';
import { StocktakeController, StocktakeService } from './stocktake';
import 'reflect-metadata';
import { InvoiceEvidenceController, InvoiceEvidenceService } from './invoice-evidence';
import { DeliveryHealthController, DeliveryHealthService } from './delivery-health';
import { Module } from '@nestjs/common';
import { Db } from './db';
import { EquipmentController, EquipmentService } from './equipment';
import { FinanceController, FinanceService } from './finance';
import { AuthController, AuthService } from './auth';
import { SessionGuard } from './security';
import { DomainController, DomainService } from './domain';
import { AssetPhotoController, AssetPhotoService } from './asset-photos';
import { ScanController, ScanService } from './scan';
import { LabelController, LabelService } from './labels';
import { DataTransferController, DataTransferService } from './data-transfers';
import { AdminDashboardController, AdminDashboardService } from './admin-dashboard';
import { PushController, PushService } from './push';
import { NotificationsController, NotificationsService } from './notifications';
@Module({
  controllers: [
    LifecycleController,
    StocktakeController,
    InvoiceEvidenceController,
    DeliveryHealthController,
    EquipmentController,
    FinanceController,
    AuthController,
    DomainController,
    AssetPhotoController,
    ScanController,
    LabelController,
    DataTransferController,
    AdminDashboardController,
    PushController,
    NotificationsController,
  ],
  providers: [
    LifecycleService,
    StocktakeService,
    InvoiceEvidenceService,
    DeliveryHealthService,
    EquipmentService,
    FinanceService,
    Db,
    AuthService,
    SessionGuard,
    DomainService,
    AssetPhotoService,
    ScanService,
    LabelService,
    DataTransferService,
    AdminDashboardService,
    PushService,
    NotificationsService,
  ],
})
export class AppModule {}
