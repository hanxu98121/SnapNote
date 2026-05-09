import { readSystemPrompt, writeSystemPrompt } from './_lib/neon.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.status(200).json({ prompt: await readSystemPrompt() });
      return;
    }

    if (req.method === 'PUT') {
      await writeSystemPrompt(req.body?.prompt || '');
      res.status(200).json({ prompt: await readSystemPrompt() });
      return;
    }

    res.setHeader('Allow', 'GET, PUT');
    res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
