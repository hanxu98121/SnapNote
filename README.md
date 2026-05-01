# Screenshot To Obsidian

Local-only web app for turning grouped screenshots into Obsidian-ready Markdown with a multimodal AI model. This app does not use OCR.

## Run

```bash
npm install
npm run dev
```

Open the Vite URL, usually `http://127.0.0.1:5173`.

If running inside WSL, use a Linux Node.js install. Windows `npm.exe` can fail on the WSL UNC path during Vite commands.

Enter the Doubao/Ark API key and endpoint ID in the web page. They are sent to the local backend for generation and are not written to `state.json`.

## Workflow

1. Put screenshots into `input_image/`.
2. Click `Refresh input_image` in the web app.
3. Enter Doubao/Ark API key and endpoint ID at the top of the page.
4. Drag related images into the same group.
5. Write one instruction for each group.
6. Click `Generate` to send that group's images and instruction to the multimodal model.
7. Edit the Markdown output if needed.
8. Click `Save to output` to write a `.md` file under `output/`.

## Configuration

- API key is entered in the web UI.
- Endpoint ID / model is entered in the web UI.
- Base URL is editable in the web UI and defaults to `https://ark.cn-beijing.volces.com/api/v3`.

Do not put API keys in source files. The current UI keeps the key in browser memory for the running page session.

## Notes

- The app sends local images as base64 data URLs to the OpenAI SDK-compatible chat completions API.
- Before sending, the backend auto-rotates and compresses images to JPEG within 1600x1600 to avoid large multimodal requests timing out.
- Regeneration includes the original images, current instruction, and previous Markdown.
- Generated notes are saved only to `output/`; this first version does not write directly to an Obsidian vault.
