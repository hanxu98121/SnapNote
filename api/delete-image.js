import { del } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, DELETE');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const image = req.body?.image || {};
    const pathname = image.pathname || (typeof image.id === 'string' && image.id.startsWith('blob:') ? image.id.slice(5) : '');
    if (!pathname) {
      res.status(400).json({ error: 'Missing Blob pathname.' });
      return;
    }

    await del(pathname);
    res.status(200).json({ deleted: pathname });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
