import path from 'node:path';
import { list } from '@vercel/blob';

function imageFromBlob(blob) {
  return {
    id: `blob:${blob.pathname}`,
    name: path.basename(blob.pathname),
    pathname: blob.pathname,
    url: `/api/blob-view?pathname=${encodeURIComponent(blob.pathname)}`,
    source: 'cloud'
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'PUT') {
      res.status(200).json({ groups: [] });
      return;
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, PUT');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(200).json({ images: [], groups: [], storage: 'browser' });
      return;
    }

    const blobs = await list({ prefix: 'images/' });
    const images = blobs.blobs.map(imageFromBlob).sort((a, b) => a.name.localeCompare(b.name));
    res.status(200).json({ images, groups: [], storage: 'blob' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
