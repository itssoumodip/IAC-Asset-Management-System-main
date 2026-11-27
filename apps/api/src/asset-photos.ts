import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
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

/** Labels for extra pictures; must match the check in migration 064. */
export const EXTRA_PHOTO_LABELS = [
  'Front', 'Back', 'Left side', 'Right side', 'Top', 'Screen', 'Keyboard', 'Serial label', 'Ports',
  'Damage', 'Accessories', 'Other',
] as const;
/** Extra pictures per asset, on top of the main photo. */
export const MAX_EXTRA_PHOTOS = 6;
const extraInput = z
  .object({
    dataUrl: photoInput.shape.dataUrl,
    label: z.enum(EXTRA_PHOTO_LABELS),
    reason: text(1000),
  })
  .strict();
const removeInput = z.object({ reason: text(1000) }).strict();

/** More pictures of one asset (front, back, screen…), beside the main photo. */
@Injectable()
export class AssetExtraPhotoService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** The asset row (locked), after checking the viewer may see it. */
  private async visible(req: AuthRequest, assetId: string, client: any, lock: 'SHARE' | 'UPDATE') {
    const asset = found(
      (
        await this.db.query(
          `SELECT id,owning_team_id FROM assets WHERE id=$1 AND removed_at IS NULL FOR ${lock}`,
          [assetId],
          client,
        )
      )[0],
    );
    const values: any[] = [assetId];
    const scope = assetScope(req.user, values);
    found((await this.db.query(`SELECT a.id FROM assets a WHERE a.id=$1 AND ${scope}`, values, client))[0]);
    return asset as { id: string; owning_team_id: string | undefined };
  }

  async list(req: AuthRequest, assetId: string) {
    id(assetId);
    return this.db.tx(async (client) => {
      await this.visible(req, assetId, client, 'SHARE');
      const rows = await this.db.query(
        `SELECT p.id,p.label,p.content,p.created_at,u.display_name AS added_by
           FROM asset_extra_photos p LEFT JOIN users u ON u.id=p.created_by
          WHERE p.asset_id=$1 ORDER BY p.created_at,p.id`,
        [assetId],
        client,
      );
      return {
        max: MAX_EXTRA_PHOTOS,
        labels: EXTRA_PHOTO_LABELS,
        items: rows.map((r: any) => ({
          id: r.id as string,
          label: r.label as string,
          dataUrl: `data:image/jpeg;base64,${r.content.toString('base64')}`,
          addedAt: r.created_at,
          addedBy: r.added_by as string | null,
        })),
      };
    });
  }

  async add(req: AuthRequest, assetId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.photo');
    id(assetId);
    const { dataUrl, label, reason } = parse(extraInput, body);
    const { content, sha256 } = await sanitizeImage(dataUrl, ASSET_PHOTO);
    return this.db.tx(async (client) => {
      const asset = await this.visible(req, assetId, client, 'UPDATE');
      assertCan(req.user, 'asset.photo', asset.owning_team_id);
      const [{ n }] = await this.db.query(
        'SELECT count(*)::int AS n FROM asset_extra_photos WHERE asset_id=$1',
        [assetId],
        client,
      );
      if (n >= MAX_EXTRA_PHOTOS)
        throw new ConflictException(`An asset can have up to ${MAX_EXTRA_PHOTOS} more pictures. Remove one first.`);
      const [row] = await this.db.query(
        `INSERT INTO asset_extra_photos(asset_id,label,content,sha256,created_by)
         VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`,
        [assetId, label, content, sha256, req.user.id],
        client,
      );
      await this.db.audit(client, req.user, 'asset', assetId, 'ASSET_EXTRA_PHOTO_ADDED', {
        photoId: row.id,
        label,
        byteSize: content.length,
        sha256,
        reason,
      });
      return { id: row.id as string, label, addedAt: row.created_at };
    });
  }

  async remove(req: AuthRequest, assetId: string, photoId: string, body: unknown) {
    assertCanSomewhere(req.user, 'asset.photo');
    id(assetId);
    id(photoId);
    const { reason } = parse(removeInput, body);
    return this.db.tx(async (client) => {
      const asset = await this.visible(req, assetId, client, 'UPDATE');
      assertCan(req.user, 'asset.photo', asset.owning_team_id);
      const row = found(
        (
          await this.db.query(
            'DELETE FROM asset_extra_photos WHERE id=$1 AND asset_id=$2 RETURNING label,sha256',
            [photoId, assetId],
            client,
          )
        )[0],
      );
      await this.db.audit(client, req.user, 'asset', assetId, 'ASSET_EXTRA_PHOTO_REMOVED', {
        photoId,
        label: row.label,
        sha256: row.sha256,
        reason,
      });
      return { removed: true };
    });
  }
}

@Controller('assets/:id/photos')
@UseGuards(SessionGuard)
export class AssetExtraPhotoController {
  constructor(@Inject(AssetExtraPhotoService) private readonly service: AssetExtraPhotoService) {}

  @Get()
  list(@Req() req: AuthRequest, @Param('id') assetId: string) {
    return this.service.list(req, assetId);
  }

  @Post()
  add(@Req() req: AuthRequest, @Param('id') assetId: string, @Body() body: unknown) {
    return this.service.add(req, assetId, body);
  }

  @Post(':photoId/remove')
  remove(
    @Req() req: AuthRequest,
    @Param('id') assetId: string,
    @Param('photoId') photoId: string,
    @Body() body: unknown,
  ) {
    return this.service.remove(req, assetId, photoId, body);
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
