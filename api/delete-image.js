import { deleteImage } from './_lib/neon.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, DELETE');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const image = req.body?.image || {};
    const deleted = await deleteImage(image);
    if (!deleted) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    res.status(200).json({ deleted });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
