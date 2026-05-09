import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import OpenAI from 'openai';
import { Pool } from 'pg';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'output');
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif']);
const importableImageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff']);
const databaseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || '';
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false }
    })
  : null;
let schemaReady = null;

const app = express();
app.use(express.json({ limit: '80mb' }));

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
  await fs.mkdir(outputDir, { recursive: true });
}

async function ensureDatabase() {
  if (!pool) throw new Error('Missing Neon connection string. Set NEON_DATABASE_URL or DATABASE_URL.');
  if (!schemaReady) {
    schemaReady = initSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('snapnote-schema'))");
    await client.query(`
      create table if not exists snapnote_state (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create table if not exists snapnote_images (
        id text primary key,
        name text not null unique,
        mime_type text not null,
        size integer not null,
        data bytea not null,
        created_at timestamptz not null default now()
      )
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function dbQuery(text, params = []) {
  await ensureDatabase();
  return pool.query(text, params);
}

async function dbOne(text, params = []) {
  const result = await dbQuery(text, params);
  return result.rows[0] || null;
}

async function readState() {
  const row = await dbOne('select value from snapnote_state where key = $1', ['groups']);
  return row?.value || { groups: [] };
}

async function writeState(state) {
  await dbQuery(
    `insert into snapnote_state (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    ['groups', JSON.stringify({ groups: Array.isArray(state.groups) ? state.groups : [] })]
  );
}

async function readSystemPrompt() {
  const row = await dbOne('select value from snapnote_state where key = $1', ['system_prompt']);
  const prompt = row?.value?.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : fallbackSystemPrompt;
}

async function writeSystemPrompt(prompt) {
  if (!prompt?.trim()) throw new Error('System prompt cannot be empty.');
  await dbQuery(
    `insert into snapnote_state (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    ['system_prompt', JSON.stringify({ prompt })]
  );
}

async function listImages() {
  const rows = await dbQuery('select id, name, mime_type, size from snapnote_images order by name asc, created_at asc');
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: `/api/images/${encodeURIComponent(row.id)}`,
    source: 'neon',
    size: row.size,
    mimeType: row.mime_type
  }));
}

function createDefaultGroups(images) {
  return images.map((image, index) => ({
    id: `group-${String(index + 1).padStart(3, '0')}`,
    images: [image.id],
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
  let candidate = filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let index = 2;
  while (true) {
    const row = await dbOne('select 1 from snapnote_images where name = $1 limit 1', [candidate]);
    if (!row) return candidate;
    candidate = `${base}-${index}${ext}`;
    index += 1;
  }
}

async function storeImportedImage(file) {
  const sourceName = normalizeImportedName(file?.name);
  const inputBuffer = decodeBase64(file?.data, sourceName);
  const ext = path.extname(sourceName).toLowerCase();
  const shouldTranscode = !importableImageExts.has(ext);

  if (!shouldTranscode) {
    const name = await uniqueImagePath(sourceName);
    const id = randomUUID();
    await dbQuery(
      `insert into snapnote_images (id, name, mime_type, size, data, created_at)
       values ($1, $2, $3, $4, $5, now())`,
      [id, name, getMimeType(name), inputBuffer.length, inputBuffer]
    );
    return { id, name, url: `/api/images/${encodeURIComponent(id)}`, source: 'neon', size: inputBuffer.length };
  }

  const outputName = normalizeImportedName(sourceName.replace(/\.[^.]+$/, ''), '.jpg');
  const jpegBuffer = await sharp(inputBuffer, { limitInputPixels: false })
    .rotate()
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const name = await uniqueImagePath(outputName);
  const id = randomUUID();
  await dbQuery(
    `insert into snapnote_images (id, name, mime_type, size, data, created_at)
     values ($1, $2, $3, $4, $5, now())`,
    [id, name, 'image/jpeg', jpegBuffer.length, jpegBuffer]
  );
  return { id, name, url: `/api/images/${encodeURIComponent(id)}`, source: 'neon', size: jpegBuffer.length };
}

function mergeStateWithImages(state, images) {
  const imageIds = new Set(images.map((image) => image.id));
  const imageIdByName = new Map(images.map((image) => [image.name, image.id]));
  const groupedIds = new Set();
  const groups = [];

  for (const group of state.groups || []) {
    const keptImages = (group.images || [])
      .map((value) => imageIdByName.get(value) || value)
      .filter((value) => imageIds.has(value));
    if (keptImages.length > 0) {
      keptImages.forEach((value) => groupedIds.add(value));
    }
    groups.push(normalizeGroup({ ...group, images: keptImages }));
  }

  for (const image of images) {
    if (groupedIds.has(image.id)) continue;
    groups.push({
      id: uniqueGroupId(groups),
      images: [image.id],
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
  const row =
    (await dbOne('select name, mime_type, data, size from snapnote_images where id = $1', [filename])) ||
    (await dbOne('select name, mime_type, data, size from snapnote_images where name = $1', [filename]));
  if (!row) throw new Error(`Image not found: ${filename}`);
  const original = Buffer.from(row.data);
  try {
    const data = await sharp(original, { limitInputPixels: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return {
      url: `data:image/jpeg;base64,${data.toString('base64')}`,
      bytes: data.length,
      originalBytes: row.size || original.length
    };
  } catch (error) {
    console.warn(`Could not compress ${row.name}; sending original image. ${error.message}`);
    return {
      url: `data:${row.mime_type || getMimeType(row.name)};base64,${original.toString('base64')}`,
      bytes: original.length,
      originalBytes: row.size || original.length
    };
  }
}

async function deleteImageRecord(image) {
  const id = image?.id || '';
  const name = image?.name || '';
  const row =
    (id ? await dbOne('select id from snapnote_images where id = $1', [id]) : null) ||
    (name ? await dbOne('select id from snapnote_images where name = $1', [name]) : null) ||
    (typeof image?.pathname === 'string' ? await dbOne('select id from snapnote_images where name = $1', [path.basename(image.pathname)]) : null);
  if (!row) return null;
  await dbQuery('delete from snapnote_images where id = $1', [row.id]);
  return row.id;
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

app.get('/api/images/:id', async (req, res, next) => {
  try {
    const row = await dbOne('select name, mime_type, data from snapnote_images where id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Image not found' });
    res.setHeader('Content-Type', row.mime_type || getMimeType(row.name));
    res.send(Buffer.from(row.data));
  } catch (error) {
    next(error);
  }
});

app.post('/api/import-images', async (req, res, next) => {
  try {
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
    const deleted = await deleteImageRecord(image);
    if (!deleted) return res.status(404).json({ error: 'Image not found.' });
    res.json({ deleted });
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
await ensureDatabase();
app.listen(8787, '127.0.0.1', () => {
  console.log('Screenshot To Obsidian server running at http://127.0.0.1:8787');
});
