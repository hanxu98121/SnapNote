import OpenAI from 'openai';
import sharp from 'sharp';
import { get } from '@vercel/blob';

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

function buildTextPrompt(group) {
  const retryText = group.markdown
    ? `\n\n这是上一版输出，如果用户要求重写或改进，请在保留有用信息的基础上生成新版 Markdown：\n${group.markdown}`
    : '';
  return `请根据这些截图生成 Obsidian Markdown。\n\n用户对本组图片的说明：\n${group.instruction || '无额外说明'}${retryText}`;
}

function getClient(config = {}) {
  const apiKey = config.apiKey;
  const baseURL = config.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';
  if (!apiKey) throw new Error('Missing API key. Enter your Doubao/Ark API key in the web UI.');
  return new OpenAI({ apiKey, baseURL, timeout: 300_000, maxRetries: 0 });
}

function getModel(config = {}) {
  if (!config.model) throw new Error('Missing model endpoint. Enter your Doubao/Ark endpoint ID in the web UI.');
  return config.model;
}

function extractMarkdownText(response) {
  const message = response.choices?.[0]?.message;
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

async function streamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function imageToDataUrl(image) {
  if (!image?.pathname) throw new Error(`Missing Blob pathname for ${image?.name || 'image'}.`);
  const result = await get(image.pathname, { access: 'private' });
  if (result?.statusCode !== 200) throw new Error(`Could not read ${image.name || image.pathname}.`);
  const original = await streamToBuffer(result.stream);
  const data = await sharp(original, { limitInputPixels: false })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${data.toString('base64')}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const group = req.body?.group;
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!group) {
      res.status(400).json({ error: 'Missing group payload.' });
      return;
    }
    if (images.length === 0) {
      res.status(400).json({ error: 'This group has no cloud images to generate from.' });
      return;
    }

    const providerConfig = req.body?.provider || {};
    if (providerConfig.provider && providerConfig.provider !== 'doubao') {
      res.status(400).json({ error: `Unsupported provider: ${providerConfig.provider}` });
      return;
    }

    const systemPrompt = req.body?.systemPrompt || fallbackSystemPrompt;
    const content = [{ type: 'text', text: `${systemPrompt}\n\n${buildTextPrompt(group)}` }];
    for (const image of images) {
      content.push({ type: 'image_url', image_url: { url: await imageToDataUrl(image) } });
    }

    const response = await getClient(providerConfig).chat.completions.create({
      model: getModel(providerConfig),
      messages: [{ role: 'user', content }]
    });

    const markdown = extractMarkdownText(response);
    if (!markdown) throw new Error('Model returned an empty response.');

    res.status(200).json({
      ...group,
      markdown,
      status: 'generated',
      error: '',
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
}
