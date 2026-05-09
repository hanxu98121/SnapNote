import { importImageFile } from './_lib/neon.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files were provided.' });
      return;
    }

    const imported = [];
    for (const file of files) {
      imported.push(await importImageFile(file));
    }

    res.status(200).json({ imported });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
