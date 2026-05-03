import { handleUpload } from '@vercel/blob/client';

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

    const result = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ['image/jpeg'],
        maximumSizeInBytes: 50 * 1024 * 1024,
        addRandomSuffix: false,
        allowOverwrite: false,
        tokenPayload: pathname
      }),
      onUploadCompleted: async () => {}
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
