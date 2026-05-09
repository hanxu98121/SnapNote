import { listImages, readState, writeState } from './_lib/neon.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'PUT') {
      const state = { groups: Array.isArray(req.body.groups) ? req.body.groups : [] };
      await writeState(state);
      res.status(200).json(state);
      return;
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, PUT');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const images = await listImages();
    const state = await readState();
    res.status(200).json({ images, groups: state.groups || [], storage: 'neon' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
