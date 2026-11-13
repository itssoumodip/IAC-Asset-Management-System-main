import { Controller, Get, Inject, Injectable, Param, Req, UseGuards } from '@nestjs/common';
import { Db } from './db';
import { NON_REPORTABLE_STATUSES, assetScope, found, parse, text } from './domain-helpers';
import { AuthRequest, SessionGuard } from './security';

const codeInput = text(200);

@Injectable()
export class ScanService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async view(req: AuthRequest, assetCode: string) {
    const values: any[] = [parse(codeInput, assetCode)];
    const scope = assetScope(req.user, values);
    const lookupScope = req.user.roles.includes('TECHNICIAN') ? scope : 'TRUE';
    const row = found(
      (
        await this.db.query(
          `SELECT a.id,a.asset_code,a.category,a.asset_type,a.manufacturer,a.model,a.status,
                  d.name AS department,l.code AS location_code,l.site,l.floor,l.room,
                  custody.employee_name,custody.employee_designation,custody.employee_department,
                  custody.acknowledgement AS custody_acknowledgement,custody.assigned_at,
                  EXISTS(SELECT 1 FROM asset_photos p WHERE p.asset_id=a.id) AS has_photo,
                  (${scope}) AS can_view_full,
                  -- Older flat locations: "site › building › floor › room"; tree nodes: their tree path.
                  CASE WHEN l.parent_id IS NULL AND NULLIF(btrim(coalesce(l.room,'')),'') IS NOT NULL
                       THEN concat_ws(' › ',NULLIF(l.site,''),NULLIF(l.building,''),NULLIF(l.floor,''),NULLIF(l.room,''))
                       ELSE loc_path.path END AS location_path
           FROM assets a
           LEFT JOIN departments d ON d.id=a.department_id
           LEFT JOIN locations l ON l.id=a.location_id
           LEFT JOIN LATERAL (
             WITH RECURSIVE loc_tree AS (
               SELECT l3.id,l3.name,l3.site,l3.code,l3.parent_id,1 AS depth
               FROM locations l3 WHERE l3.id = l.id
               UNION ALL
               SELECT p.id,p.name,p.site,p.code,p.parent_id,ct.depth+1
               FROM locations p JOIN loc_tree ct ON p.id=ct.parent_id
             )
             SELECT string_agg(
                      COALESCE(NULLIF(btrim(name),''), site, code), ' › ' ORDER BY depth DESC
                    ) AS path
             FROM loc_tree
           ) loc_path ON true
           LEFT JOIN LATERAL (
             SELECT u.display_name AS employee_name,u.designation AS employee_designation,
                    ud.name AS employee_department,s.acknowledgement,s.assigned_at
             FROM assignments s
             JOIN users u ON u.id=s.user_id
             LEFT JOIN departments ud ON ud.id=u.department_id
             WHERE s.asset_id=a.id AND s.ended_at IS NULL
             LIMIT 1
           ) custody ON true
           WHERE (
             lower(a.asset_code)=lower(btrim($1))
             OR EXISTS (
                SELECT 1 FROM asset_identifiers ai
                WHERE ai.asset_id=a.id AND lower(ai.value)=lower(btrim($1))
             )
           )
           AND (${lookupScope})`,
          values,
        )
      )[0],
    );
    return {
      id: row.id as string,
      assetCode: row.asset_code as string,
      category: row.category as string,
      assetType: row.asset_type as string,
      manufacturer: (row.manufacturer ?? null) as string | null,
      model: (row.model ?? null) as string | null,
      department: (row.department ?? null) as string | null,
      custodian: row.employee_name
        ? {
            name: row.employee_name as string,
            designation: (row.employee_designation ?? null) as string | null,
            department: (row.employee_department ?? null) as string | null,
            acknowledgement: row.custody_acknowledgement as string,
            assignedAt: row.assigned_at as Date,
          }
        : null,
      location: row.location_code
        ? {
            site: (row.site ?? row.location_code) as string,
            floor: (row.floor ?? null) as string | null,
            room: (row.room ?? null) as string | null,
            path: (row.location_path ?? row.site ?? row.location_code ?? null) as string | null,
          }
        : null,
      status: row.status as string,
      hasPhoto: row.has_photo as boolean,
      reportable: !(NON_REPORTABLE_STATUSES as readonly string[]).includes(row.status),
      canViewFull: row.can_view_full as boolean,
    };
  }

  async photo(req: AuthRequest, assetCode: string) {
    const asset = await this.view(req, assetCode);
    const [photo] = await this.db.query('SELECT content FROM asset_photos WHERE asset_id=$1', [
      asset.id,
    ]);
    return {
      dataUrl: photo ? `data:image/jpeg;base64,${photo.content.toString('base64')}` : null,
    };
  }
}

@Controller('scan/:assetCode')
@UseGuards(SessionGuard)
export class ScanController {
  constructor(@Inject(ScanService) private readonly service: ScanService) {}

  @Get()
  view(@Req() req: AuthRequest, @Param('assetCode') assetCode: string) {
    return this.service.view(req, assetCode);
  }

  @Get('photo')
  photo(@Req() req: AuthRequest, @Param('assetCode') assetCode: string) {
    return this.service.photo(req, assetCode);
  }
}
