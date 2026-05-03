# SnapNote

Screenshot-to-Obsidian workflow for grouped screenshots, with local storage and optional Vercel Blob sync.

## What It Does

- Bulk load images from your device, with automatic resize to max width `1800px` and JPEG compression.
- Keep image groups and Markdown output in the browser for local continuity.
- Store images locally in `input_image/` during local development, or in private Vercel Blob when deployed.
- Export all generated Markdown into one combined file with a top-level `# SnapNote Output` heading.
- Delete mistaken images from the UI.

## Run Locally

```bash
npm install
npm run dev
```

Open the Vite URL, usually `http://127.0.0.1:5173`.

If you are running inside WSL, use a Linux Node.js install. Windows `npm.exe` can fail on the WSL UNC path during Vite commands.

## Local Workflow

1. Put screenshots in `input_image/` or use `Bulk load`.
2. Click `Refresh input_image`.
3. Enter your Doubao/Ark API key and endpoint ID.
4. Drag related images into the same group.
5. Write one instruction for each group.
6. Optionally open `System prompt`, edit it, and click `Save prompt`.
7. Click `Generate` for one group or `Generate all` for every group with images.
8. Edit the Markdown output if needed.
9. Click `Save to output` to write a `.md` file under `output/`.
10. Click `Export Markdown` to download or share a combined Markdown file.

## Vercel Setup

This branch supports private Vercel Blob storage.

1. Create or connect a private Blob store in Vercel.
2. Link the project so `BLOB_READ_WRITE_TOKEN` is injected into the project.
3. Run `vercel env pull` locally if you want matching environment variables.
4. Deploy with Git or `vercel deploy`.

## Configuration

- API key is entered in the web UI.
- Endpoint ID / model is entered in the web UI.
- Base URL is editable in the web UI and defaults to `https://ark.cn-beijing.volces.com/api/v3`.
- The default system prompt is stored in `app/system-prompt.json`.

Do not put API keys in source files. The current UI keeps the key in browser memory for the running page session.

## Notes

- Bulk load resizes images in the browser before upload to reduce transfer size.
- Uploaded images are normalized to JPEG when needed.
- The app sends images to the OpenAI-compatible chat completions API.
- Before sending, the backend auto-rotates and compresses images to JPEG within `1600x1600` for generation.
- Generated notes can be saved individually or exported as one combined Markdown file.
- `Generate all` runs groups sequentially to avoid sending many multimodal requests at once.

## 中文

# SnapNote

用于整理截图到 Obsidian 的工作流工具，支持本地存储和可选的 Vercel Blob 云端同步。

## 功能

- 批量导入图片，自动缩放到最大宽度 `1800px` 并压缩为 JPEG。
- 图片分组和 Markdown 输出保存在浏览器中，方便本地连续使用。
- 本地开发时图片保存在 `input_image/`，部署到 Vercel 时可使用私有 Blob 存储。
- 一键导出全部 Markdown，合并成一个文件，顶部带一级标题 `# SnapNote Output`。
- 支持在界面里删除误上传的图片。

## 本地运行

```bash
npm install
npm run dev
```

打开 Vite 地址，通常是 `http://127.0.0.1:5173`。

如果在 WSL 中运行，请使用 Linux 版 Node.js。Windows 的 `npm.exe` 可能会在 WSL UNC 路径下执行 Vite 时失败。

## 本地工作流

1. 把截图放进 `input_image/`，或者使用 `Bulk load` 批量导入。
2. 点击 `Refresh input_image`。
3. 输入 Doubao / Ark API key 和 endpoint ID。
4. 把相关图片拖进同一组。
5. 为每一组写一条说明。
6. 需要的话打开 `System prompt`，修改后点击 `Save prompt`。
7. 对单组点击 `Generate`，或者点击 `Generate all` 批量生成。
8. 按需编辑 Markdown 输出。
9. 点击 `Save to output`，把单个 `.md` 文件写入 `output/`。
10. 点击 `Export Markdown`，下载或分享合并后的 Markdown。

## Vercel 配置

这个分支支持私有 Vercel Blob 存储。

1. 在 Vercel 里创建或连接一个 private Blob store。
2. 把项目连接到 Blob store，让 `BLOB_READ_WRITE_TOKEN` 自动注入项目环境变量。
3. 如果本地环境需要一致配置，可以执行 `vercel env pull`。
4. 通过 Git 或 `vercel deploy` 部署。

## 配置

- API key 在网页里输入。
- Endpoint ID / model 在网页里输入。
- Base URL 可以在网页里修改，默认是 `https://ark.cn-beijing.volces.com/api/v3`。
- 默认 system prompt 存在 `app/system-prompt.json`。

不要把 API key 写进源码。当前 UI 只会把 key 保存在本次浏览器会话里。

## 说明

- 批量导入时，图片会先在浏览器里缩放，再上传，减少体积。
- 需要时，上传图片会统一转成 JPEG。
- 应用会把图片发送给兼容 OpenAI 的 chat completions API。
- 生成前，后端会把图片自动旋转并压缩到 `1600x1600` 以内。
- 生成出来的笔记可以单独保存，也可以合并导出成一个 Markdown 文件。
- `Generate all` 会按顺序逐组生成，避免一次发出太多多模态请求。
