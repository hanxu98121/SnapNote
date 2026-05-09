import { query } from '../_lib/neon.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const row = await query('select name, mime_type, data from snapnote_images where id = $1', [req.query.id]);
    const image = row.rows[0];
    if (!image) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    res.setHeader('Content-Type', image.mime_type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(Buffer.from(image.data));
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
