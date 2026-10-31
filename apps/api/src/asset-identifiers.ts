import {
  Body,
  Controller,
  Delete,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { camel, found, id, parse, text } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';

const input = z.object({
  kind: z.enum(['QR', 'BARCODE', 'NFC', 'RFID']),
  value: text(200),
  reason: text(1000),
}).strict();

@Injectable()
export class AssetIdentifierService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async add(req: AuthRequest, assetId: string, body: unknown) {
    id(assetId);
    const data = parse(input, body);
    return this.db.tx(async (c) => {
      const asset = found((await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0]);
      assertCan(req.user, 'asset.edit', asset.owning_team_id);
      const [row] = await this.db.query(
        'INSERT INTO asset_identifiers(asset_id,kind,value,created_by) VALUES($1,$2,$3,$4) RETURNING *',
        [assetId, data.kind, data.value, req.user.id],
        c,
      );
      await this.db.audit(c, req.user, 'asset', assetId, 'IDENTIFIER_ADDED', {
        kind: data.kind,
        value: data.value,
        reason: data.reason,
      });
      return camel(row);
    });
  }

  async remove(req: AuthRequest, assetId: string, identifierId: string, body: unknown) {
    id(assetId);
    id(identifierId);
    const { reason } = parse(z.object({ reason: text(1000) }).strict(), body);
    return this.db.tx(async (c) => {
      const asset = found((await this.db.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [assetId], c))[0]);
      assertCan(req.user, 'asset.edit', asset.owning_team_id);
      const row = found((await this.db.query(
        'DELETE FROM asset_identifiers WHERE id=$1 AND asset_id=$2 RETURNING *',
        [identifierId, assetId],
        c,
      ))[0]);
      await this.db.audit(c, req.user, 'asset', assetId, 'IDENTIFIER_REMOVED', {
        identifierId,
        kind: row.kind,
        value: row.value,
        reason,
      });
      return { removed: true };
    });
  }
}

@Controller('assets/:assetId/identifiers')
@UseGuards(SessionGuard)
export class AssetIdentifierController {
  constructor(@Inject(AssetIdentifierService) private readonly service: AssetIdentifierService) {}

  @Post()
  add(@Req() req: AuthRequest, @Param('assetId') assetId: string, @Body() body: unknown) {
    return this.service.add(req, assetId, body);
  }

  @Delete(':identifierId')
  remove(
    @Req() req: AuthRequest,
    @Param('assetId') assetId: string,
    @Param('identifierId') identifierId: string,
    @Body() body: unknown,
  ) {
    return this.service.remove(req, assetId, identifierId, body);
  }
}
