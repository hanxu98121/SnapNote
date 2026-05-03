import { Readable } from 'node:stream';
import { get } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.searchParams.get('pathname');
    if (!pathname) {
      res.status(400).json({ error: 'Missing pathname.' });
      return;
    }

    const result = await get(pathname, { access: 'private' });
    if (result?.statusCode !== 200) {
      res.status(404).send('Not found');
      return;
    }

    res.setHeader('Content-Type', result.blob.contentType || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(result.stream).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
