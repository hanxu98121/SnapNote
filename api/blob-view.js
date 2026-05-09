import { Readable } from 'node:stream';
import { query as neonQuery } from './_lib/neon.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.searchParams.get('pathname');
    if (!pathname) {
      res.status(400).json({ error: 'Missing pathname.' });
      return;
    }

    const result = await neonQuery('select name, mime_type, data from snapnote_images where name = $1', [pathname]);
    const row = result.rows[0];
    if (!row) {
      res.status(404).send('Not found');
      return;
    }

    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.from(Buffer.from(row.data)).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
