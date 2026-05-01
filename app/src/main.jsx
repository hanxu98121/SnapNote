import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  const [images, setImages] = useState([]);
  const [groups, setGroups] = useState([]);
  const groupsRef = useRef([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [providerConfig, setProviderConfig] = useState({
    provider: 'doubao',
    apiKey: '',
    model: '',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3'
  });
  const imageMap = useMemo(() => new Map(images.map((image) => [image.name, image])), [images]);

  useEffect(() => {
    refreshState();
  }, []);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  async function refreshState() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setImages(data.images || []);
      groupsRef.current = data.groups || [];
      setGroups(data.groups || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function persistGroups(nextGroups) {
    groupsRef.current = nextGroups;
    setGroups(nextGroups);
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: nextGroups })
    });
    if (!response.ok) throw new Error(await readError(response));
  }

  function updateGroup(groupId, patch) {
    const nextGroups = groupsRef.current.map((group) =>
      group.id === groupId ? { ...group, ...patch, updatedAt: new Date().toISOString() } : group
    );
    groupsRef.current = nextGroups;
    setGroups(nextGroups);
  }

  async function generateGroup(groupId) {
    setError('');
    if (!providerConfig.apiKey.trim() || !providerConfig.model.trim()) {
      setError('Enter Doubao/Ark API key and endpoint ID before generating.');
      return;
    }
    const nextGroups = groupsRef.current.map((group) =>
      group.id === groupId ? { ...group, status: 'generating', error: '', updatedAt: new Date().toISOString() } : group
    );
    try {
      await persistGroups(nextGroups);
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 310_000);
      const response = await fetch(`/api/generate/${encodeURIComponent(groupId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerConfig }),
        signal: controller.signal
      });
      window.clearTimeout(timeoutId);
      if (!response.ok) throw new Error(await readError(response));
      const updated = await response.json();
      const updatedGroups = groupsRef.current.map((group) => (group.id === groupId ? updated : group));
      groupsRef.current = updatedGroups;
      setGroups(updatedGroups);
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
      const updatedGroups = groupsRef.current.map((item) => (item.id === groupId ? updated : item));
      groupsRef.current = updatedGroups;
      setGroups(updatedGroups);
    } catch (err) {
      setError(err.message);
    }
  }

  async function copyMarkdown(groupId) {
    const group = groupsRef.current.find((item) => item.id === groupId);
    await navigator.clipboard.writeText(group.markdown || '');
  }

  async function splitImage(groupId, imageName) {
    const source = groupsRef.current.find((group) => group.id === groupId);
    if (!source || source.images.length < 2) return;
    const nextGroups = groupsRef.current
      .map((group) => (group.id === groupId ? { ...group, images: group.images.filter((name) => name !== imageName) } : group))
      .concat({
        id: nextGroupId(groupsRef.current),
        images: [imageName],
        instruction: '',
        markdown: '',
        status: 'pending',
        outputFile: '',
        updatedAt: new Date().toISOString()
      });
    await persistGroups(nextGroups);
  }

  async function moveImageToGroup(imageName, fromGroupId, toGroupId) {
    if (fromGroupId === toGroupId) return;
    const nextGroups = groupsRef.current
      .map((group) => {
        if (group.id === fromGroupId) return { ...group, images: group.images.filter((name) => name !== imageName) };
        if (group.id === toGroupId) return { ...group, images: [...group.images, imageName], status: 'pending' };
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
        <div>
          <p className="eyebrow">Local multimodal workflow</p>
          <h1>Screenshot To Obsidian</h1>
        </div>
        <div className="actions">
          <button onClick={refreshState}>Refresh input_image</button>
          <button onClick={createEmptyGroup}>New empty group</button>
        </div>
      </header>

      <section className="notice">
        Put screenshots in <code>input_image/</code>. Drag images between groups. Each group is sent to the AI model with one shared instruction. Markdown saves to <code>output/</code>.
      </section>

      <ProviderPanel config={providerConfig} onChange={setProviderConfig} />

      {error && <section className="error">{error}</section>}
      {loading ? <section className="empty">Loading images and state...</section> : null}
      {!loading && groups.length === 0 ? <section className="empty">No screenshots found in input_image/.</section> : null}

      <section className="groups">
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            imageMap={imageMap}
            onInstructionChange={(instruction) => updateGroup(group.id, { instruction })}
            onPersist={() => persistGroups(groupsRef.current)}
            onMarkdownChange={(markdown) => updateGroup(group.id, { markdown, status: group.status === 'saved' ? 'generated' : group.status })}
            onGenerate={() => generateGroup(group.id)}
            onSave={() => saveGroup(group.id)}
            onCopy={() => copyMarkdown(group.id)}
            onDropImage={moveImageToGroup}
            onSplitImage={splitImage}
          />
        ))}
      </section>
    </main>
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

function GroupRow({ group, imageMap, onInstructionChange, onPersist, onMarkdownChange, onGenerate, onSave, onCopy, onDropImage, onSplitImage }) {
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
          {group.images.map((imageName) => {
            const image = imageMap.get(imageName);
            return (
              <figure className="image-card" draggable onDragStart={(event) => handleDragStart(event, imageName)} key={imageName}>
                {image ? <img src={image.url} alt={imageName} /> : <div className="missing-image">Missing image</div>}
                <figcaption title={imageName}>{imageName}</figcaption>
                {group.images.length > 1 ? <button onClick={() => onSplitImage(group.id, imageName)}>Split</button> : null}
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

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

createRoot(document.getElementById('root')).render(<App />);
