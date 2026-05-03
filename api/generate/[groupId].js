import OpenAI from 'openai';
import sharp from 'sharp';
import { get } from '@vercel/blob';

const fallbackSystemPrompt = '你是一位专业的个人知识库管理专家。请将截图整理为适合 Obsidian 的 Markdown，标题从 ## 开始，去除 UI 噪音，只输出 Markdown。';

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
