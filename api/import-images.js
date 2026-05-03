import path from 'node:path';
import { put } from '@vercel/blob';
import sharp from 'sharp';

const passthroughExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff']);

function cleanFilename(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeImportedName(name, fallbackExt = '') {
  const parsed = path.parse(path.basename(name || 'image'));
  const safeBase = cleanFilename(parsed.name || 'image') || 'image';
  const ext = (parsed.ext || fallbackExt || '').toLowerCase();
  return `${safeBase}${ext}`;
}

function decodeBase64(base64, filename) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new Error(`Missing file data for ${filename}.`);
  }
  return Buffer.from(base64, 'base64');
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/png';
}

async function normalizeImage(file) {
  const sourceName = normalizeImportedName(file?.name);
  const inputBuffer = decodeBase64(file?.data, sourceName);
  const ext = path.extname(sourceName).toLowerCase();

  if (passthroughExts.has(ext)) {
    return {
      name: sourceName,
      contentType: file?.type || getContentType(sourceName),
      buffer: inputBuffer
    };
  }

  const outputName = normalizeImportedName(sourceName.replace(/\.[^.]+$/, ''), '.jpg');
  const buffer = await sharp(inputBuffer, { limitInputPixels: false }).rotate().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return { name: outputName, contentType: 'image/jpeg', buffer };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(501).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured for this deployment.' });
      return;
    }

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files were provided.' });
      return;
    }

    const imported = [];
    for (const file of files) {
      const image = await normalizeImage(file);
      const pathname = `images/${Date.now()}-${image.name}`;
      const blob = await put(pathname, image.buffer, {
        access: 'private',
        contentType: image.contentType
      });
      imported.push({
        id: `blob:${blob.pathname}`,
        name: path.basename(blob.pathname),
        pathname: blob.pathname,
        url: `/api/blob-view?pathname=${encodeURIComponent(blob.pathname)}`,
        source: 'cloud'
      });
    }

    res.status(200).json({ imported });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
