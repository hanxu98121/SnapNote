import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import OpenAI from 'openai';
import sharp from 'sharp';
import { del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const inputImageDir = path.join(rootDir, 'input_image');
const inputTextDir = path.join(rootDir, 'input_text');
const outputDir = path.join(rootDir, 'output');
const statePath = path.join(rootDir, 'state.json');
const systemPromptPath = path.join(__dirname, 'system-prompt.json');
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif']);
const importableImageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff']);

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use('/images', express.static(inputImageDir));

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

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(inputImageDir, { recursive: true }),
    fs.mkdir(inputTextDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true })
  ]);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { groups: [] };
    throw error;
  }
}

async function writeState(state) {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function readSystemPrompt() {
  try {
    const data = JSON.parse(await fs.readFile(systemPromptPath, 'utf8'));
    return typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt : fallbackSystemPrompt;
  } catch (error) {
    if (error.code === 'ENOENT') return fallbackSystemPrompt;
    throw error;
  }
}

async function writeSystemPrompt(prompt) {
  if (!prompt?.trim()) throw new Error('System prompt cannot be empty.');
  await fs.writeFile(systemPromptPath, JSON.stringify({ prompt }, null, 2) + '\n', 'utf8');
}

async function listImages() {
  await ensureDirs();
  const entries = await fs.readdir(inputImageDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !imageExts.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(inputImageDir, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({
      id: entry.name,
      name: entry.name,
      url: `/images/${encodeURIComponent(entry.name)}`,
      source: 'local',
      size: stat.size
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function createDefaultGroups(images) {
  return images.map((image, index) => ({
    id: `group-${String(index + 1).padStart(3, '0')}`,
    images: [image.name],
    instruction: '',
    markdown: '',
    status: 'pending',
    outputFile: '',
    updatedAt: new Date().toISOString()
    }));
}

function decodeBase64(base64, filename) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new Error(`Missing file data for ${filename}.`);
  }
  return Buffer.from(base64, 'base64');
}

function normalizeImportedName(name, fallbackExt = '') {
  const base = path.basename(name || 'image');
  const parsed = path.parse(base);
  const safeBase = cleanFilename(parsed.name || 'image') || 'image';
  const ext = (parsed.ext || fallbackExt || '').toLowerCase();
  return `${safeBase}${ext}`;
}

async function uniqueImagePath(filename) {
  let candidate = path.join(inputImageDir, filename);
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(inputImageDir, `${base}-${index}${ext}`);
      index += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

async function storeImportedImage(file) {
  const sourceName = normalizeImportedName(file?.name);
  const inputBuffer = decodeBase64(file?.data, sourceName);
  const ext = path.extname(sourceName).toLowerCase();
  const shouldTranscode = !importableImageExts.has(ext);

  if (!shouldTranscode) {
    const outputPath = await uniqueImagePath(sourceName);
    await fs.writeFile(outputPath, inputBuffer);
    const name = path.basename(outputPath);
    return { id: name, name, url: `/images/${encodeURIComponent(name)}`, source: 'local', size: inputBuffer.length };
  }

  const outputName = normalizeImportedName(sourceName.replace(/\.[^.]+$/, ''), '.jpg');
  const outputPath = await uniqueImagePath(outputName);
  const jpegBuffer = await sharp(inputBuffer, { limitInputPixels: false })
    .rotate()
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  await fs.writeFile(outputPath, jpegBuffer);
  const name = path.basename(outputPath);
  return { id: name, name, url: `/images/${encodeURIComponent(name)}`, source: 'local', size: jpegBuffer.length };
}

function mergeStateWithImages(state, images) {
  const imageNames = new Set(images.map((image) => image.name));
  const groupedNames = new Set();
  const groups = [];

  for (const group of state.groups || []) {
    const keptImages = (group.images || []).filter((name) => imageNames.has(name));
    if (keptImages.length > 0) {
      keptImages.forEach((name) => groupedNames.add(name));
    }
    groups.push(normalizeGroup({ ...group, images: keptImages }));
  }

  for (const image of images) {
    if (groupedNames.has(image.name)) continue;
    groups.push({
      id: uniqueGroupId(groups),
      images: [image.name],
      instruction: '',
      markdown: '',
      status: 'pending',
      outputFile: '',
      updatedAt: new Date().toISOString()
    });
  }

  return { groups };
}

function normalizeGroup(group) {
  if (group.status !== 'generating') return group;

  const updatedAt = Date.parse(group.updatedAt || '');
  const isStale = Number.isNaN(updatedAt) || Date.now() - updatedAt > 2 * 60 * 1000;
  if (!isStale) return group;

  return {
    ...group,
    status: 'failed',
    error: 'Previous generation did not finish. Click Generate to retry.'
  };
}

function uniqueGroupId(groups) {
  let index = groups.length + 1;
  const existing = new Set(groups.map((group) => group.id));
  while (existing.has(`group-${String(index).padStart(3, '0')}`)) index += 1;
  return `group-${String(index).padStart(3, '0')}`;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return 'image/png';
}

async function imageToDataUrl(filename) {
  const imagePath = safeImagePath(filename);
  const original = await fs.readFile(imagePath);
  try {
    const data = await sharp(original, { limitInputPixels: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return {
      url: `data:image/jpeg;base64,${data.toString('base64')}`,
      bytes: data.length,
      originalBytes: original.length
    };
  } catch (error) {
    console.warn(`Could not compress ${filename}; sending original image. ${error.message}`);
    return {
      url: `data:${getMimeType(filename)};base64,${original.toString('base64')}`,
      bytes: original.length,
      originalBytes: original.length
    };
  }
}

function safeImagePath(filename) {
  const imagePath = path.resolve(inputImageDir, filename);
  if (!imagePath.startsWith(inputImageDir + path.sep)) {
    throw new Error(`Invalid image path: ${filename}`);
  }
  return imagePath;
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

function buildTextPrompt(group, previousMarkdown = '') {
  const retryMarkdown = previousMarkdown || group.markdown || '';
  const retryText = retryMarkdown
    ? `\n\n这是上一版输出。如果用户要求重写、补充说明或优化结构，请在保留有用信息的基础上直接改写，不要忽略这份内容：\n${retryMarkdown}`
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
  const model = config.model;
  if (!model) throw new Error('Missing model endpoint. Enter your Doubao/Ark endpoint ID in the web UI.');
  return model;
}

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

async function uniqueOutputPath(filename) {
  let candidate = path.join(outputDir, filename);
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(outputDir, `${base}-${index}${ext}`);
      index += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

app.get('/api/state', async (_req, res, next) => {
  try {
    const images = await listImages();
    const state = mergeStateWithImages(await readState(), images);
    await writeState(state);
    res.json({ images, groups: state.groups });
  } catch (error) {
    next(error);
  }
});

app.put('/api/state', async (req, res, next) => {
  try {
    const state = { groups: Array.isArray(req.body.groups) ? req.body.groups : [] };
    await writeState(state);
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post('/api/import-images', async (req, res, next) => {
  try {
    if (req.body?.type) {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(501).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured for client uploads.' });
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
      return res.json(result);
    }

    await ensureDirs();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) return res.status(400).json({ error: 'No files were provided.' });

    const imported = [];
    for (const file of files) {
      imported.push(await storeImportedImage(file));
    }

    res.json({ imported });
  } catch (error) {
    next(error);
  }
});

app.post('/api/delete-image', async (req, res, next) => {
  try {
    const image = req.body?.image || {};
    if (image.pathname || (typeof image.id === 'string' && image.id.startsWith('blob:'))) {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(501).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured for Blob deletion.' });
      }
      const pathname = image.pathname || image.id.slice(5);
      await del(pathname);
      return res.json({ deleted: pathname });
    }

    const filename = image.name || image.id;
    if (!filename) return res.status(400).json({ error: 'Missing image name.' });
    await fs.unlink(safeImagePath(filename));
    res.json({ deleted: filename });
  } catch (error) {
    next(error);
  }
});

app.get('/api/system-prompt', async (_req, res, next) => {
  try {
    res.json({ prompt: await readSystemPrompt() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/system-prompt', async (req, res, next) => {
  try {
    await writeSystemPrompt(req.body?.prompt || '');
    res.json({ prompt: await readSystemPrompt() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/generate/:groupId', async (req, res, next) => {
  try {
    const state = await readState();
    const group = state.groups.find((item) => item.id === req.params.groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    group.status = 'generating';
    group.updatedAt = new Date().toISOString();
    await writeState(state);

    const systemPrompt = await readSystemPrompt();
    const content = [{ type: 'text', text: `${systemPrompt}\n\n${buildTextPrompt(group, req.body?.previousMarkdown || '')}` }];
    let compressedBytes = 0;
    let originalBytes = 0;
    for (const image of group.images) {
      const dataUrl = await imageToDataUrl(image);
      compressedBytes += dataUrl.bytes;
      originalBytes += dataUrl.originalBytes;
      content.push({ type: 'image_url', image_url: { url: dataUrl.url } });
    }

    const providerConfig = req.body?.provider || {};
    if (providerConfig.provider && providerConfig.provider !== 'doubao') {
      return res.status(400).json({ error: `Unsupported provider: ${providerConfig.provider}` });
    }

    const start = Date.now();
    console.log(
      `Generating ${group.id}: ${group.images.length} image(s), model=${providerConfig.model || '(missing)'}, images=${formatBytes(compressedBytes)} compressed from ${formatBytes(originalBytes)}`
    );

    const response = await getClient(providerConfig).chat.completions.create({
      model: getModel(providerConfig),
      messages: [{ role: 'user', content }]
    });

    group.markdown = extractMarkdownText(response);
    if (!group.markdown) throw new Error('Model returned an empty response.');
    group.status = 'generated';
    group.updatedAt = new Date().toISOString();
    await writeState(state);
    console.log(`Generated ${group.id} in ${Math.round((Date.now() - start) / 1000)}s`);
    res.json(group);
  } catch (error) {
    console.error(`Generation failed for ${req.params.groupId}: ${error.message}`);
    try {
      const state = await readState();
      const group = state.groups.find((item) => item.id === req.params.groupId);
      if (group) {
        group.status = 'failed';
        group.error = error.message;
        group.updatedAt = new Date().toISOString();
        await writeState(state);
      }
    } catch {
      // Preserve the original model/API error.
    }
    next(error);
  }
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

app.post('/api/save/:groupId', async (req, res, next) => {
  try {
    await ensureDirs();
    const state = await readState();
    const group = state.groups.find((item) => item.id === req.params.groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const markdown = req.body.markdown || group.markdown;
    if (!markdown?.trim()) return res.status(400).json({ error: 'Markdown is empty' });

    const outputPath = await uniqueOutputPath(filenameFromMarkdown(markdown, group.id));
    await fs.writeFile(outputPath, markdown.trim() + '\n', 'utf8');

    group.markdown = markdown;
    group.status = 'saved';
    group.outputFile = path.relative(rootDir, outputPath);
    group.updatedAt = new Date().toISOString();
    await writeState(state);
    res.json(group);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Unknown error' });
});

await ensureDirs();
app.listen(8787, '127.0.0.1', () => {
  console.log('Screenshot To Obsidian server running at http://127.0.0.1:8787');
});
