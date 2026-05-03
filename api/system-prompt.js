const fallbackSystemPrompt = '你是一位专业的个人知识库管理专家。请将截图整理为适合 Obsidian 的 Markdown，标题从 ## 开始，去除 UI 噪音，只输出 Markdown。';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({ prompt: fallbackSystemPrompt });
    return;
  }

  if (req.method === 'PUT') {
    res.status(200).json({ prompt: req.body?.prompt || fallbackSystemPrompt });
    return;
  }

  res.setHeader('Allow', 'GET, PUT');
  res.status(405).json({ error: 'Method not allowed.' });
}
