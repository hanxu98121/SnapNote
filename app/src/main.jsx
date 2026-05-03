import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { upload } from '@vercel/blob/client';
import './styles.css';

const GROUPS_STORAGE_KEY = 'snapnote.groups.v1';
const PROVIDER_STORAGE_KEY = 'snapnote.provider.v1';
const MAX_UPLOAD_WIDTH = 1800;
const EXPORT_TITLE = 'SnapNote Output';

function App() {
  const [images, setImages] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedImageIds, setSelectedImageIds] = useState([]);
  const groupsRef = useRef([]);
  const bulkLoadInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkLoadStatus, setBulkLoadStatus] = useState('');
  const [error, setError] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [promptSaved, setPromptSaved] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [providerConfig, setProviderConfig] = useState(() => readStoredProviderConfig());
  const imageMap = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);

  useEffect(() => {
    refreshState();
    refreshSystemPrompt();
  }, []);

  async function refreshSystemPrompt() {
    try {
      const response = await fetch('/api/system-prompt');
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setSystemPrompt(data.prompt || '');
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveSystemPrompt() {
    setError('');
    setPromptSaved(false);
    try {
      const response = await fetch('/api/system-prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: systemPrompt })
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setSystemPrompt(data.prompt || '');
      setPromptSaved(true);
      window.setTimeout(() => setPromptSaved(false), 1800);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    const currentImageIds = new Set(images.map((image) => image.id));
    setSelectedImageIds((selected) => selected.filter((imageId) => currentImageIds.has(imageId)));
  }, [images]);

  useEffect(() => {
    writeStoredProviderConfig(providerConfig);
  }, [providerConfig]);

  const selectedImageCount = selectedImageIds.length;
  const allImagesSelected = images.length > 0 && selectedImageCount === images.length;

  async function refreshState() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      const nextImages = normalizeImages(data.images || []);
      const storedGroups = readStoredGroups();
      const fallbackGroups = normalizeGroups(data.groups || [], nextImages);
      const nextGroups = mergeGroupsWithImages(storedGroups.length > 0 ? storedGroups : fallbackGroups, nextImages);
      setImages(nextImages);
      groupsRef.current = nextGroups;
      setGroups(nextGroups);
      writeStoredGroups(nextGroups);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openBulkLoadPicker() {
    bulkLoadInputRef.current?.click();
  }

  async function handleBulkLoadChange(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    setError('');
    setBulkLoading(true);
    setBulkLoadStatus(`Preparing ${files.length} image(s)...`);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setBulkLoadStatus(`Resizing ${file.name} (${index + 1}/${files.length})...`);
        const uploadFile = await prepareImageForUpload(file);
        setBulkLoadStatus(`Uploading ${uploadFile.name} (${index + 1}/${files.length})...`);
        await upload(`images/${Date.now()}-${uploadFile.name}`, uploadFile, {
          access: 'private',
          handleUploadUrl: '/api/import-images',
          multipart: true,
          contentType: uploadFile.type,
          onUploadProgress: ({ percentage }) => {
            setBulkLoadStatus(`Uploading ${uploadFile.name} (${Math.round(percentage)}%)`);
          }
        });
      }
      setBulkLoadStatus(`Imported ${files.length} image(s).`);
      await refreshState();
    } catch (err) {
      if (isBlobUploadUnavailable(err)) {
        setBulkLoadStatus('Blob upload unavailable. Saving images locally...');
        await uploadImagesLocally(files);
        setBulkLoadStatus(`Imported ${files.length} image(s) locally.`);
        await refreshState();
      } else {
        setError(err.message);
      }
    } finally {
      setBulkLoading(false);
    }
  }

  async function uploadImagesLocally(files) {
    const payload = await Promise.all(
      files.map(async (file) => {
        const uploadFile = await prepareImageForUpload(file);
        return {
          name: uploadFile.name,
          type: uploadFile.type,
          data: await blobToBase64(uploadFile)
        };
      })
    );

    const response = await fetch('/api/import-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payload })
    });
    if (!response.ok) throw new Error(await readError(response));
  }

  async function persistGroups(nextGroups) {
    groupsRef.current = nextGroups;
    setGroups(nextGroups);
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: nextGroups })
    });
    writeStoredGroups(nextGroups);
    if (!response.ok) throw new Error(await readError(response));
  }

  function updateGroup(groupId, patch) {
    const nextGroups = groupsRef.current.map((group) =>
      group.id === groupId ? { ...group, ...patch, updatedAt: new Date().toISOString() } : group
    );
    groupsRef.current = nextGroups;
    setGroups(nextGroups);
  }

  async function generateGroup(groupId, options = {}) {
    const { markGenerating = true } = options;
    setError('');
    if (!providerConfig.apiKey.trim() || !providerConfig.model.trim()) {
      setError('Enter Doubao/Ark API key and endpoint ID before generating.');
      return;
    }
    if (markGenerating) {
      const nextGroups = groupsRef.current.map((group) =>
        group.id === groupId ? { ...group, status: 'generating', error: '', updatedAt: new Date().toISOString() } : group
      );
      try {
        await persistGroups(nextGroups);
      } catch (err) {
        setError(err.message);
        return;
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 310_000);
      const response = await fetch(`/api/generate/${encodeURIComponent(groupId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerConfig,
          group: groupsRef.current.find((group) => group.id === groupId),
          images: groupsRef.current
            .find((group) => group.id === groupId)
            ?.images.map((id) => imageMap.get(id))
            .filter(Boolean),
          systemPrompt
        }),
        signal: controller.signal
      });
      window.clearTimeout(timeoutId);
      if (!response.ok) throw new Error(await readError(response));
      const updated = await response.json();
      const updatedGroups = groupsRef.current.map((group) => (group.id === groupId ? updated : group));
      groupsRef.current = updatedGroups;
      setGroups(updatedGroups);
      writeStoredGroups(updatedGroups);
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Generation timed out after 5 minutes. Check the model endpoint and retry.' : err.message;
      setError(message);
      const failedGroups = groupsRef.current.map((group) =>
        group.id === groupId ? { ...group, status: 'failed', error: message, updatedAt: new Date().toISOString() } : group
      );
      groupsRef.current = failedGroups;
      setGroups(failedGroups);
    }
  }

  async function generateAll() {
    const targetGroupIds = groupsRef.current.filter((group) => group.images.length > 0).map((group) => group.id);
    if (targetGroupIds.length === 0) return;

    setGeneratingAll(true);
    try {
      const nextGroups = groupsRef.current.map((group) =>
        targetGroupIds.includes(group.id)
          ? { ...group, status: 'generating', error: '', updatedAt: new Date().toISOString() }
          : group
      );
      await persistGroups(nextGroups);

      const concurrency = normalizeConcurrency(providerConfig.concurrency);
      const pendingGroupIds = [...targetGroupIds];
      const workerCount = Math.min(concurrency, pendingGroupIds.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (pendingGroupIds.length > 0) {
          const nextGroupId = pendingGroupIds.shift();
          if (!nextGroupId) return;
          await generateGroup(nextGroupId, { markGenerating: false });
        }
      });

      await Promise.all(workers);
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingAll(false);
    }
  }

  function selectAllImages() {
    setSelectedImageIds(images.map((image) => image.id));
  }

  function clearSelectedImages() {
    setSelectedImageIds([]);
  }

  function toggleSelectAllImages() {
    if (allImagesSelected) {
      clearSelectedImages();
      return;
    }
    selectAllImages();
  }

  async function saveGroup(groupId) {
    setError('');
    const group = groupsRef.current.find((item) => item.id === groupId);
    try {
      const response = await fetch(`/api/save/${encodeURIComponent(groupId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: group.markdown })
      });
      if (!response.ok) throw new Error(await readError(response));
      const updated = await response.json();
      const updatedGroups = groupsRef.current.map((item) => (item.id === groupId ? { ...item, ...updated } : item));
      groupsRef.current = updatedGroups;
      setGroups(updatedGroups);
      writeStoredGroups(updatedGroups);
    } catch (err) {
      setError(err.message);
    }
  }

  async function copyMarkdown(groupId) {
    const group = groupsRef.current.find((item) => item.id === groupId);
    await navigator.clipboard.writeText(group.markdown || '');
  }

  async function deleteImage(imageId) {
    await deleteImages([imageId]);
  }

  async function deleteImages(imageIds) {
    setError('');
    const uniqueIds = Array.from(new Set(imageIds)).filter((imageId) => imageMap.has(imageId));
    if (uniqueIds.length === 0) return;

    try {
      for (const imageId of uniqueIds) {
        const image = imageMap.get(imageId);
        const response = await fetch('/api/delete-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image })
        });
        if (!response.ok) throw new Error(await readError(response));
      }

      const deletedIds = new Set(uniqueIds);
      const nextImages = images.filter((item) => !deletedIds.has(item.id));
      const nextGroups = groupsRef.current
        .map((group) => ({
          ...group,
          images: group.images.filter((id) => !deletedIds.has(id)),
          updatedAt: new Date().toISOString()
        }))
        .filter((group) => group.images.length > 0 || group.instruction?.trim() || group.markdown?.trim());

      setImages(nextImages);
      setSelectedImageIds((selected) => selected.filter((imageId) => !deletedIds.has(imageId)));
      groupsRef.current = nextGroups;
      setGroups(nextGroups);
      writeStoredGroups(nextGroups);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBulkDeleteSelected() {
    if (selectedImageIds.length === 0) return;
    const confirmMessage = `Delete ${selectedImageIds.length} selected picture(s)? This will remove them from their groups too.`;
    if (!window.confirm(confirmMessage)) return;
    await deleteImages(selectedImageIds);
  }

  async function exportAllMarkdown() {
    setError('');
    try {
      const markdown = buildExportMarkdown(groupsRef.current);
      if (!markdown) {
        setError('No Markdown output to export yet.');
        return;
      }
      const filename = `${new Date().toISOString().slice(0, 10)}-snapnote-output.md`;
      const file = new File([markdown], filename, { type: 'text/markdown;charset=utf-8' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: EXPORT_TITLE,
          text: EXPORT_TITLE
        });
        return;
      }

      downloadFile(file);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }

  async function splitImage(groupId, imageId) {
    const source = groupsRef.current.find((group) => group.id === groupId);
    if (!source || source.images.length < 2) return;
    const nextGroups = groupsRef.current
      .map((group) => (group.id === groupId ? { ...group, images: group.images.filter((id) => id !== imageId) } : group))
      .concat({
        id: nextGroupId(groupsRef.current),
        images: [imageId],
        instruction: '',
        markdown: '',
        status: 'pending',
        outputFile: '',
        updatedAt: new Date().toISOString()
      });
    await persistGroups(nextGroups);
  }

  async function moveImageToGroup(imageId, fromGroupId, toGroupId) {
    if (fromGroupId === toGroupId) return;
    const nextGroups = groupsRef.current
      .map((group) => {
        if (group.id === fromGroupId) return { ...group, images: group.images.filter((id) => id !== imageId) };
        if (group.id === toGroupId) return { ...group, images: [...group.images, imageId], status: 'pending' };
        return group;
      })
      .filter((group) => group.images.length > 0);
    await persistGroups(nextGroups);
  }

  async function createEmptyGroup() {
    await persistGroups([
      ...groupsRef.current,
      {
        id: nextGroupId(groupsRef.current),
        images: [],
        instruction: '',
        markdown: '',
        status: 'pending',
        outputFile: '',
        updatedAt: new Date().toISOString()
      }
    ]);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">Local multimodal workflow</p>
          <h1>Screenshot To Obsidian</h1>
        </div>
      </header>

      <section className="top-actions-panel">
        <div className="selection-head">
          <div>
            <p className="eyebrow">Picture selection</p>
            <h2>Bulk delete after generation</h2>
          </div>
          <div className="selection-summary">
            {images.length === 0 ? 'No pictures loaded yet.' : `${selectedImageCount}/${images.length} selected`}
          </div>
        </div>
        <div className="actions selection-actions">
          <button onClick={toggleSelectAllImages} disabled={images.length === 0}>
            {allImagesSelected ? 'Clear all' : 'Select all'}
          </button>
          <button onClick={clearSelectedImages} disabled={selectedImageCount === 0}>
            Clear selection
          </button>
          <button onClick={handleBulkDeleteSelected} disabled={selectedImageCount === 0}>
            Delete selected{selectedImageCount > 0 ? ` (${selectedImageCount})` : ''}
          </button>
        </div>
      </section>

      <section className="actions topbar-actions">
        <input
          ref={bulkLoadInputRef}
          className="bulk-load-input"
          type="file"
          accept="image/*,.heic,.heif,.bmp,.gif,.tif,.tiff,.avif"
          multiple
          onChange={handleBulkLoadChange}
        />
        <button onClick={openBulkLoadPicker} disabled={bulkLoading}>
          {bulkLoading ? 'Loading...' : 'Bulk load'}
        </button>
        <button onClick={refreshState}>Refresh input_image</button>
        <button className="primary" onClick={generateAll} disabled={generatingAll || groups.every((group) => group.images.length === 0)}>
          {generatingAll ? 'Generating all...' : 'Generate all'}
        </button>
        <button onClick={exportAllMarkdown} disabled={!groups.some((group) => group.markdown?.trim())}>
          Export Markdown
        </button>
        <button onClick={createEmptyGroup}>New empty group</button>
      </section>

      <section className="notice">
        Put screenshots in <code>input_image/</code> locally or use Bulk load to import pictures. On Vercel, imports sync to private Blob storage and group layout is kept in this browser.
      </section>

      <ProviderPanel config={providerConfig} onChange={setProviderConfig} />
      <SystemPromptPanel prompt={systemPrompt} saved={promptSaved} onChange={setSystemPrompt} onSave={saveSystemPrompt} />

      {error && <section className="error">{error}</section>}
      {bulkLoadStatus ? <section className="notice">{bulkLoadStatus}</section> : null}
      {loading ? <section className="empty">Loading images and state...</section> : null}
      {!loading && groups.length === 0 ? <section className="empty">No screenshots found in input_image/.</section> : null}

      <section className="groups">
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            imageMap={imageMap}
            selectedImageIds={selectedImageIds}
            onInstructionChange={(instruction) => updateGroup(group.id, { instruction })}
            onPersist={() => persistGroups(groupsRef.current)}
            onMarkdownChange={(markdown) => updateGroup(group.id, { markdown, status: group.status === 'saved' ? 'generated' : group.status })}
            onGenerate={() => generateGroup(group.id)}
            onSave={() => saveGroup(group.id)}
            onCopy={() => copyMarkdown(group.id)}
            onDropImage={moveImageToGroup}
            onSplitImage={splitImage}
            onDeleteImage={deleteImage}
            onToggleImageSelection={(imageId) =>
              setSelectedImageIds((selected) =>
                selected.includes(imageId) ? selected.filter((id) => id !== imageId) : [...selected, imageId]
              )
            }
          />
        ))}
      </section>
    </main>
  );
}

function SystemPromptPanel({ prompt, saved, onChange, onSave }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="system-prompt-panel">
      <div className="system-prompt-head">
        <div>
          <p className="eyebrow">Backend JSON prompt</p>
          <h2>System prompt</h2>
        </div>
        <div className="actions">
          <button onClick={() => setOpen((value) => !value)}>{open ? 'Hide prompt' : 'Show prompt'}</button>
          <button onClick={onSave}>Save prompt</button>
        </div>
      </div>
      {open ? (
        <textarea
          className="system-prompt-textarea"
          value={prompt}
          onChange={(event) => onChange(event.target.value)}
          placeholder="System prompt JSON is stored at app/system-prompt.json"
        />
      ) : null}
      {saved ? <p className="saved-path">System prompt saved to <code>app/system-prompt.json</code>.</p> : null}
    </section>
  );
}

function ProviderPanel({ config, onChange }) {
  function update(patch) {
    onChange({ ...config, ...patch });
  }

  return (
    <section className="provider-panel">
      <div>
        <p className="eyebrow">Model provider</p>
        <h2>Doubao Ark</h2>
      </div>
      <label>
        API key
        <input
          type="password"
          placeholder="ARK_API_KEY"
          value={config.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          autoComplete="off"
        />
      </label>
      <label>
        Endpoint ID / model
        <input
          placeholder="ep-..."
          value={config.model}
          onChange={(event) => update({ model: event.target.value })}
          autoComplete="off"
        />
      </label>
      <label>
        Concurrency
        <input
          type="number"
          min="1"
          max="10"
          step="1"
          value={config.concurrency}
          onChange={(event) => update({ concurrency: normalizeConcurrency(event.target.value) })}
          autoComplete="off"
        />
      </label>
      <label>
        Base URL
        <input
          value={config.baseURL}
          onChange={(event) => update({ baseURL: event.target.value })}
          autoComplete="off"
        />
      </label>
    </section>
  );
}

function GroupRow({
  group,
  imageMap,
  selectedImageIds,
  onInstructionChange,
  onPersist,
  onMarkdownChange,
  onGenerate,
  onSave,
  onCopy,
  onDropImage,
  onSplitImage,
  onDeleteImage,
  onToggleImageSelection
}) {
  const [dragOver, setDragOver] = useState(false);

  function handleDragStart(event, imageName) {
    event.dataTransfer.setData('application/json', JSON.stringify({ imageName, fromGroupId: group.id }));
    event.dataTransfer.effectAllowed = 'move';
  }

  async function handleDrop(event) {
    event.preventDefault();
    setDragOver(false);
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = JSON.parse(raw);
    await onDropImage(payload.imageName, payload.fromGroupId, group.id);
  }

  return (
    <article
      className={`group-row ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <section className="image-column">
        <div className="column-head">
          <strong>{group.id}</strong>
          <StatusBadge status={group.status} />
        </div>
        <div className="image-stack">
          {group.images.length === 0 ? <div className="drop-placeholder">Drop images here</div> : null}
          {group.images.map((imageId) => {
            const image = imageMap.get(imageId);
            const selected = selectedImageIds.includes(imageId);
            return (
              <figure
                className={`image-card ${selected ? 'selected' : ''}`}
                draggable
                onDragStart={(event) => handleDragStart(event, imageId)}
                key={imageId}
              >
                <button
                  type="button"
                  className="image-select"
                  aria-pressed={selected}
                  aria-label={`${selected ? 'Deselect' : 'Select'} ${image?.name || imageId}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleImageSelection(imageId);
                  }}
                >
                  <span className="image-select-box">{selected ? '✓' : ''}</span>
                </button>
                {image ? <img src={image.url} alt={image.name} /> : <div className="missing-image">Missing image</div>}
                <figcaption title={image?.name || imageId}>
                  {image?.name || imageId}
                  {image?.source ? <span className="image-source">{image.source}</span> : null}
                </figcaption>
                <div className="image-actions">
                  {group.images.length > 1 ? <button onClick={() => onSplitImage(group.id, imageId)}>Split</button> : null}
                  <button onClick={() => onDeleteImage(imageId)}>Delete</button>
                </div>
              </figure>
            );
          })}
        </div>
      </section>

      <section className="instruction-column">
        <label htmlFor={`${group.id}-instruction`}>Instruction for this group</label>
        <textarea
          id={`${group.id}-instruction`}
          placeholder="Example: These are continuous screenshots of one article. Merge them, remove UI noise, preserve key facts and steps."
          value={group.instruction || ''}
          onChange={(event) => onInstructionChange(event.target.value)}
          onBlur={onPersist}
        />
        <div className="button-row">
          <button className="primary" onClick={onGenerate} disabled={group.images.length === 0}>
            {group.status === 'generating' ? 'Retry' : group.markdown ? 'Regenerate' : 'Generate'}
          </button>
        </div>
        {group.error ? <p className="inline-error">{group.error}</p> : null}
      </section>

      <section className="output-column">
        <label htmlFor={`${group.id}-markdown`}>Markdown output</label>
        <textarea
          id={`${group.id}-markdown`}
          placeholder="AI-generated Markdown appears here. You can edit before saving."
          value={group.markdown || ''}
          onChange={(event) => onMarkdownChange(event.target.value)}
          onBlur={onPersist}
        />
        <div className="button-row">
          <button onClick={onCopy} disabled={!group.markdown}>Copy</button>
          <button onClick={onSave} disabled={!group.markdown}>Save to output</button>
        </div>
        {group.outputFile ? <p className="saved-path">Saved: <code>{group.outputFile}</code></p> : null}
      </section>
    </article>
  );
}

function StatusBadge({ status }) {
  return <span className={`status status-${status || 'pending'}`}>{status || 'pending'}</span>;
}

function nextGroupId(groups) {
  const existing = new Set(groups.map((group) => group.id));
  let index = groups.length + 1;
  while (existing.has(`group-${String(index).padStart(3, '0')}`)) index += 1;
  return `group-${String(index).padStart(3, '0')}`;
}

function normalizeImages(rawImages) {
  return rawImages.map((image) => ({
    ...image,
    id: image.id || image.pathname || image.name,
    name: image.name || image.pathname || image.id,
    source: image.source || 'local'
  }));
}

function normalizeGroups(rawGroups, images) {
  const idByName = new Map(images.map((image) => [image.name, image.id]));
  return rawGroups.map((group) => ({
    ...group,
    images: (group.images || []).map((id) => idByName.get(id) || id)
  }));
}

function mergeGroupsWithImages(rawGroups, images) {
  const imageIds = new Set(images.map((image) => image.id));
  const groupedIds = new Set();
  const groups = [];

  for (const group of rawGroups) {
    const keptImages = (group.images || []).filter((id) => imageIds.has(id));
    if (keptImages.length === 0) continue;
    keptImages.forEach((id) => groupedIds.add(id));
    groups.push({ ...group, images: keptImages, status: group.status === 'generating' ? 'pending' : group.status || 'pending' });
  }

  for (const image of images) {
    if (groupedIds.has(image.id)) continue;
    groups.push({
      id: nextGroupId(groups),
      images: [image.id],
      instruction: '',
      markdown: '',
      status: 'pending',
      outputFile: '',
      updatedAt: new Date().toISOString()
    });
  }

  return groups;
}

function readStoredGroups() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GROUPS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredGroups(groups) {
  window.localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
}

function readStoredProviderConfig() {
  const fallback = {
    provider: 'doubao',
    apiKey: '',
    model: '',
    concurrency: 1,
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
  };

  try {
    const raw = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return {
      provider: typeof parsed.provider === 'string' && parsed.provider.trim() ? parsed.provider : fallback.provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : fallback.apiKey,
      model: typeof parsed.model === 'string' ? parsed.model : fallback.model,
      concurrency: normalizeConcurrency(parsed.concurrency),
      baseURL: typeof parsed.baseURL === 'string' && parsed.baseURL.trim() ? parsed.baseURL : fallback.baseURL
    };
  } catch {
    return fallback;
  }
}

function writeStoredProviderConfig(config) {
  window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(config));
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(10, Math.max(1, parsed));
}

function buildExportMarkdown(groups) {
  const sections = groups
    .filter((group) => group.markdown?.trim())
    .map((group) => group.markdown.trim());
  if (sections.length === 0) return '';
  return [`# ${EXPORT_TITLE}`, '', ...sections].join('\n\n') + '\n';
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function prepareImageForUpload(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_UPLOAD_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`Could not resize ${file.name}.`);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
    return new File([blob], jpegName(file.name), { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not compress image.'));
    }, type, quality);
  });
}

function jpegName(filename) {
  const base = filename.replace(/\.[^.]+$/, '') || 'image';
  return `${base}.jpg`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read image.'));
        return;
      }
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

function isBlobUploadUnavailable(error) {
  return /BLOB_READ_WRITE_TOKEN|501|not configured/i.test(error.message || '');
}

createRoot(document.getElementById('root')).render(<App />);
