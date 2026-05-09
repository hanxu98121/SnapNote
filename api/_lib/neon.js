import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';

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

const databaseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || '';
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false }
    })
  : null;
let schemaReady = null;
const importableImageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff']);

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

function cleanFilename(value) {
  return value.replace(/^#+\s*/gm, '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
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

async function query(text, params = []) {
  await ensureDatabase();
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function readState() {
  const row = await one('select value from snapnote_state where key = $1', ['groups']);
  return row?.value || { groups: [] };
}

async function writeState(state) {
  await query(
    `insert into snapnote_state (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    ['groups', JSON.stringify({ groups: Array.isArray(state.groups) ? state.groups : [] })]
  );
}

async function readSystemPrompt() {
  const row = await one('select value from snapnote_state where key = $1', ['system_prompt']);
  const prompt = row?.value?.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : fallbackSystemPrompt;
}

async function writeSystemPrompt(prompt) {
  if (!prompt?.trim()) throw new Error('System prompt cannot be empty.');
  await query(
    `insert into snapnote_state (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    ['system_prompt', JSON.stringify({ prompt })]
  );
}

async function listImages() {
  const rows = await query('select id, name, mime_type, size from snapnote_images order by name asc, created_at asc');
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: `/api/images/${encodeURIComponent(row.id)}`,
    source: 'neon',
    size: row.size,
    mimeType: row.mime_type
  }));
}

async function importImageFile(file) {
  const sourceName = normalizeImportedName(file?.name);
  const inputBuffer = decodeBase64(file?.data, sourceName);
  const ext = path.extname(sourceName).toLowerCase();
  const shouldTranscode = !importableImageExts.has(ext);

  const buffer = shouldTranscode
    ? await sharp(inputBuffer, { limitInputPixels: false }).rotate().jpeg({ quality: 82, mozjpeg: true }).toBuffer()
    : inputBuffer;
  const name = normalizeImportedName(sourceName.replace(/\.[^.]+$/, ''), shouldTranscode ? '.jpg' : ext);
  const id = randomUUID();
  await query(
    `insert into snapnote_images (id, name, mime_type, size, data, created_at)
     values ($1, $2, $3, $4, $5, now())`,
    [id, name, shouldTranscode ? 'image/jpeg' : getMimeType(name), buffer.length, buffer]
  );
  return { id, name, url: `/api/images/${encodeURIComponent(id)}`, source: 'neon', size: buffer.length };
}

async function deleteImage(image) {
  const id = image?.id || '';
  const name = image?.name || '';
  const row =
    (id ? await one('select id from snapnote_images where id = $1', [id]) : null) ||
    (name ? await one('select id from snapnote_images where name = $1', [name]) : null) ||
    (typeof image?.pathname === 'string' ? await one('select id from snapnote_images where name = $1', [path.basename(image.pathname)]) : null);
  if (!row) return null;
  await query('delete from snapnote_images where id = $1', [row.id]);
  return row.id;
}

async function imageToDataUrl(image) {
  const row =
    (await one('select name, mime_type, data, size from snapnote_images where id = $1', [image?.id || ''])) ||
    (await one('select name, mime_type, data, size from snapnote_images where name = $1', [image?.name || '']));
  if (!row) throw new Error(`Image not found: ${image?.name || image?.id || 'unknown'}`);
  const original = Buffer.from(row.data);
  const data = await sharp(original, { limitInputPixels: false })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return { url: `data:image/jpeg;base64,${data.toString('base64')}`, bytes: data.length, originalBytes: row.size || original.length };
}

export {
  fallbackSystemPrompt,
  getMimeType,
  importImageFile,
  deleteImage,
  imageToDataUrl,
  listImages,
  readState,
  readSystemPrompt,
  query,
  writeState,
  writeSystemPrompt
};
