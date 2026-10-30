import { UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export interface SanitizeOptions {
  inputLimit: number;
  outputLimit: number;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  maxPixels: number;
  message: string;
}

export interface SanitizedImage {
  content: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export const ASSET_PHOTO: SanitizeOptions = {
  inputLimit: 40 * 1024,
  outputLimit: 80 * 1024,
  maxWidth: 640,
  maxHeight: 480,
  quality: 75,
  maxPixels: 4_000_000,
  message: 'Choose a valid, non-animated JPEG or PNG picture up to 40 KB and 4 million pixels',
};

export const TICKET_PHOTO: SanitizeOptions = {
  inputLimit: 400 * 1024,
  outputLimit: 400 * 1024,
  maxWidth: 1600,
  maxHeight: 1600,
  quality: 80,
  maxPixels: 24_000_000,
  message: 'Each photo must be a JPEG or PNG picture up to 400 KB',
};

function animatedPng(bytes: Buffer): boolean {
  // Inspect PNG chunks rather than matching arbitrary pixel/compressed bytes.
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) return true;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return false;
}

export async function sanitizeImage(
  dataUrl: string,
  options: SanitizeOptions,
): Promise<SanitizedImage> {
  const invalid = (): never => {
    throw new UnprocessableEntityException(options.message);
  };
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) invalid();
  const encoded = match![2]!;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > options.inputLimit || bytes.toString('base64') !== encoded)
    invalid();
  if (
    match![1] === 'jpeg'
      ? !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    invalid();
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: options.maxPixels });
    const metadata = await image.metadata();
    if (
      metadata.format !== match![1] ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > options.maxPixels ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.format === 'png' && animatedPng(bytes))
    )
      invalid();
    // Re-encoding removes embedded metadata and never retains source bytes.
    const { data, info } = await image
      .rotate()
      .resize({
        width: options.maxWidth,
        height: options.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
    if (data.length > options.outputLimit) invalid();
    return {
      content: data,
      width: info.width,
      height: info.height,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  } catch {
    return invalid();
  }
}

export const USER_PHOTO: SanitizeOptions = {
  inputLimit: 2 * 1024 * 1024,
  outputLimit: 60 * 1024,
  maxWidth: 256,
  maxHeight: 256,
  quality: 80,
  maxPixels: 16_000_000,
  message: 'Profile photo must be a valid JPEG or PNG',
};
