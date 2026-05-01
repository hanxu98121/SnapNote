# AGENTS.md

## Project Context

- This workspace is not currently a git repo and has no CI or test config yet.
- App implementation now uses root `package.json` scripts: `npm run dev` starts Express and Vite; `npm run server` starts only the API; `npm run client` starts only Vite; `npm run build` builds the frontend.
- The backend system prompt lives in `app/system-prompt.json` and is editable via the web UI; generation should read it at request time, not duplicate it in frontend code.
- The active product spec is `document/screenshot-to-obsidian-workflow.md`; treat it as the source of truth until implementation files exist.
- The old OCR comparison experiment has been removed; do not reintroduce OCR unless the user explicitly asks for experiments.

## Target Workflow

- Build a local-only web app for turning screenshots into Obsidian-ready Markdown via a multimodal LLM.
- First version writes generated notes to `output/`; do not write directly into an Obsidian vault unless the user explicitly changes that requirement.
- Planned working folders are `input_image/` for screenshots, `input_text/` or `state.json` for per-group instructions/state, `output/` for Markdown, and `document/` for docs.
- The UI concept is three columns per dynamic group: images on the left, per-group user instructions in the middle, editable Markdown output on the right.
- Images must be draggable into groups; all images in a group share one instruction and are sent together to the multimodal model in display order.
- Support iterative regeneration: when output is unsatisfactory, send the original images, current instruction, and previous Markdown back to the model.
- `Generate all` should process groups sequentially, not concurrently, to avoid multimodal API timeouts/rate limits.

## Model/API Constraints

- Prefer a multimodal LLM directly over OCR-plus-text postprocessing.
- The current provider is Ark/Doubao via an OpenAI SDK-compatible backend call; API key, endpoint/model, and base URL are entered in the frontend and sent with generation requests.
- Never hard-code or commit API keys; do not persist frontend-entered keys into `state.json`.
- For local image inputs, prefer base64 data URLs first; local temporary HTTP URLs are the fallback. Do not require public object storage for the MVP.

## Output Rules

- Generated notes should be pure Markdown for Obsidian.
- Generated content should start at `##` or `###`, never `#`.
- Strip platform UI noise such as likes, comments, share buttons, watermarks, ads, and loading text.
- Preserve high-value facts such as names, authors, prices, locations, dates, steps, parameters, and core arguments.
- Use Markdown tables for structured attributes or comparisons.
- Include a final usage suggestion section with recommended filename, internal links, and tags.
- Keep the first implementation simple: textarea is acceptable; do not add a rich text editor unless requested.
