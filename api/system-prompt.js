import { get, put } from '@vercel/blob';

const fallbackSystemPrompt = `你是一位专业的个人知识库管理专家，擅长将截图、文本和用户说明整理成适合 Obsidian 管理的 Markdown 笔记。

要求：
1. 输出必须是 Markdown。
2. 标题从二级标题 ## 或三级标题 ### 开始，禁止使用一级标题 #。
3. 禁止使用 Emoji 和装饰性图标。
4. 去除广告、平台按钮、水印、点赞、评论、分享、加载更多等无关 UI 文案。
5. 保留高价值信息，例如名称、作者、价格、地点、时间、步骤、参数、核心观点。
6. 如果存在多项属性、对比信息或结构化数据，优先使用 Markdown 表格。
7. 不要过度扩写。如果截图信息很少，只做简洁整理。
8. 文末添加“使用建议”，包括推荐文件名、建议内部链接和标签。
9. 只输出最终 Markdown，不解释处理过程。`;

const systemPromptPathname = 'state/system-prompt.json';

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readSystemPrompt() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fallbackSystemPrompt;
  const result = await get(systemPromptPathname, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200) return fallbackSystemPrompt;
  const data = JSON.parse(await streamToText(result.stream));
  return typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt : fallbackSystemPrompt;
}

async function writeSystemPrompt(prompt) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not configured. System prompt changes cannot persist on Vercel without Blob storage.');
  }
  if (!prompt?.trim()) throw new Error('System prompt cannot be empty.');
  await put(systemPromptPathname, JSON.stringify({ prompt }, null, 2) + '\n', {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

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
