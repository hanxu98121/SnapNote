function cleanFilename(value) {
  return value
    .replace(/^#+\s*/gm, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function filenameFromMarkdown(markdown, fallback) {
  const heading = markdown.match(/^##+\s+(.+)$/m)?.[1];
  const suggestion = markdown.match(/保存为[:：]\s*([^\n]+)/)?.[1];
  const title = cleanFilename(suggestion || heading || fallback).replace(/\.md$/i, '');
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${title || fallback}.md`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const markdown = req.body?.markdown || '';
  if (!markdown.trim()) {
    res.status(400).json({ error: 'Markdown is empty.' });
    return;
  }

  const groupId = Array.isArray(req.query.groupId) ? req.query.groupId[0] : req.query.groupId;
  res.status(200).json({
    id: groupId,
    markdown,
    status: 'saved',
    outputFile: `browser:${filenameFromMarkdown(markdown, groupId || 'note')}`,
    updatedAt: new Date().toISOString()
  });
}
