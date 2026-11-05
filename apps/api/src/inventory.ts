import {
  Controller,
  Get,
  Inject,
  Injectable,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Db } from './db';
import { AuthRequest, SessionGuard } from './security';
import { assertCan } from './policy';

@Injectable()
export class InventoryService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(req: AuthRequest) {
    assertCan(req.user, 'asset.view_all');

    const rows = await this.db.query(`
      SELECT 
        a.category,
        a.asset_type,
        count(*)::int as total_count,
        count(*) FILTER (WHERE a.status = 'In Store')::int as in_store_count,
        count(*) FILTER (WHERE a.status = 'Assigned')::int as assigned_count,
        count(*) FILTER (WHERE a.status = 'Ready to Assign')::int as ready_count,
        count(*) FILTER (WHERE a.status NOT IN ('In Store', 'Assigned', 'Ready to Assign'))::int as other_count
      FROM assets a
      GROUP BY a.category, a.asset_type
      ORDER BY a.category, a.asset_type
    `);

    return { items: rows.map((r: any) => ({
      ...r,
      stock_status: r.in_store_count > 0 ? 'In Stock' : 'Out of stock',
    })) };
  }
}

@Controller('inventory')
@UseGuards(SessionGuard)
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly service: InventoryService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.service.list(req);
  }
}
