import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { assertCanSomewhere, assetScope, found, id, parse, text } from './domain-helpers';
import { ASSET_PHOTO, sanitizeImage } from './image-sanitize';
import { assertCan } from './policy';
import { AuthRequest, assertVersion, SessionGuard } from './security';

const photoInput = z
  .object({
    dataUrl: z.string().max(23 + 4 * Math.ceil(ASSET_PHOTO.inputLimit / 3)),
    reason: text(1000),
  })
  .strict();

@Injectable()
export class AssetPhotoService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async get(req: AuthRequest, assetId: string) {
    id(assetId);
    return this.db.tx(async (client) => {
      // Custody changes lock this same asset FOR UPDATE. Re-check scope in a
      // fresh statement after acquiring the lock, including after a lock wait.
      found(
        (await this.db.query('SELECT id FROM assets WHERE id=$1 FOR SHARE', [assetId], client))[0],
      );
      const values: any[] = [assetId];
      const scope = assetScope(req.user, values);
      found(
        (
          await this.db.query(
            `SELECT a.id FROM assets a WHERE a.id=$1 AND ${scope}`,
            values,
            client,
          )
        )[0],
      );
      const [photo] = await this.db.query(
        'SELECT content,updated_at FROM asset_photos WHERE asset_id=$1',
        [assetId],
        client,
      );
      return {
        dataUrl: photo ? `data:image/jpeg;base64,${photo.content.toString('base64')}` : null,
        updatedAt: photo?.updated_at ?? null,
      };
    });
  }

  async put(req: AuthRequest, assetId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.photo');
    id(assetId);
    const { dataUrl, reason } = parse(photoInput, body);
    const { content, sha256 } = await sanitizeImage(dataUrl, ASSET_PHOTO);
    return this.db.tx(async (client) => {
      const asset = found(
        (
          await this.db.query(
            'SELECT version,owning_team_id FROM assets WHERE id=$1 FOR UPDATE',
            [assetId],
            client,
          )
        )[0],
      );
      assertCan(req.user, 'asset.photo', asset.owning_team_id);
      assertVersion(req, asset.version);
      const [photo] = await this.db.query(
        `INSERT INTO asset_photos(asset_id,content,sha256,updated_by)
         VALUES($1,$2,$3,$4) ON CONFLICT(asset_id) DO UPDATE SET
         content=excluded.content,sha256=excluded.sha256,updated_by=excluded.updated_by,updated_at=now()
         RETURNING updated_at`,
        [assetId, content, sha256, req.user.id],
        client,
      );
      const [updated] = await this.db.query(
        'UPDATE assets SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version',
        [assetId],
        client,
      );
      await this.db.audit(client, req.user, 'asset', assetId, 'ASSET_PHOTO_UPDATED', {
        byteSize: content.length,
        sha256,
        reason,
      });
      return {
        dataUrl: `data:image/jpeg;base64,${content.toString('base64')}`,
        updatedAt: photo!.updated_at,
        assetVersion: updated!.version,
      };
    });
  }
}

@Controller('assets/:id/photo')
@UseGuards(SessionGuard)
export class AssetPhotoController {
  constructor(@Inject(AssetPhotoService) private readonly service: AssetPhotoService) {}

  @Get()
  get(@Req() req: AuthRequest, @Param('id') assetId: string) {
    return this.service.get(req, assetId);
  }

  @Put()
  async put(
    @Req() req: AuthRequest,
    @Param('id') assetId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.put(req, assetId, body);
    res.setHeader('ETag', `"${result.assetVersion}"`);
    return result;
  }
}
