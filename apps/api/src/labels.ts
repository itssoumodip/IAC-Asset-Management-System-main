import {
  Body,
  Controller,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Db } from './db';
import { assertCanSomewhere, idempotent, parse, uuid } from './domain-helpers';
import { assertCan } from './policy';
import { AuthRequest, SessionGuard } from './security';

const printInput = z
  .object({
    assetIds: z
      .array(uuid)
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'assetIds must be unique'),
    layout: z.enum(['A4_40', 'A4_24', 'A4_14', 'THERMAL_50x25']),
  })
  .strict();

@Injectable()
export class LabelService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async recordPrints(req: AuthRequest, body: unknown) {
    assertCanSomewhere(req.user, 'asset.label');
    const { assetIds, layout } = parse(printInput, body);
    return idempotent(
      this.db,
      req,
      'POST /asset-labels/prints',
      { assetIds, layout },
      async (c) => {
        const existing = await this.db.query(
          'SELECT owning_team_id FROM assets WHERE id=ANY($1::uuid[])',
          [assetIds],
          c,
        );
        if (existing.length !== assetIds.length) throw new NotFoundException('Asset not found');
        for (const asset of existing) assertCan(req.user, 'asset.label', asset.owning_team_id);
        const [run] = await this.db.query(
          `WITH ins AS (
           INSERT INTO asset_label_prints(asset_id,layout,printed_by,printed_at)
           SELECT x,$2,$3,now() FROM unnest($1::uuid[]) AS x RETURNING printed_at
         ) SELECT count(*)::int AS recorded,max(printed_at) AS printed_at FROM ins`,
          [assetIds, layout, req.user.id],
          c,
        );
        await this.db.audit(c, req.user, 'asset_labels', null, 'LABELS_PRINTED', {
          layout,
          count: assetIds.length,
          assetIds,
        });
        return { recorded: run!.recorded as number, printedAt: run!.printed_at as string };
      },
    );
  }
}

@Controller('asset-labels')
@UseGuards(SessionGuard)
export class LabelController {
  constructor(@Inject(LabelService) private readonly service: LabelService) {}

  @Post('prints')
  prints(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.service.recordPrints(req, body);
  }
}
