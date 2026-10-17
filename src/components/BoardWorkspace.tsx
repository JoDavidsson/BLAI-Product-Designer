import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Images,
  Link,
  LoaderCircle,
  MessageCircle,
  MousePointer2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import type { AnnotationTarget, BoardAsset, JobKind, Project } from '../../shared/model';
import AnnotationOverlay from './AnnotationOverlay';
import AnnotationPanel from './AnnotationPanel';
import './board.css';

interface Props {
  project: Project;
  onChange: (project: Project) => void;
  onToast: (message: string) => void;
  mode: 'reference' | 'screenshot';
  onGenerate: (kind: JobKind, instruction: string, screenId?: string) => void;
  helperOnline: boolean;
  /** Merge an asynchronous upload into the latest project, never the upload's snapshot. */
  onAddAsset?: (projectId: string, asset: BoardAsset) => boolean;
  /** Open a source asset from the product overview in this board's existing mode. */
  focusAsset?: { assetId: string; requestId: number };
}

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function sourceName(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return 'Uploaded image';
  }
}
function usableImage(value: string): string | undefined {
  return /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(value) || /^\/sample\/[a-zA-Z0-9_.-]+$/.test(value)
    ? value
    : safeLink(value);
}

function AssetImage({ asset, large = false }: { asset: BoardAsset; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = usableImage(asset.imageUrl);
  useEffect(() => setFailed(false), [asset.imageUrl]);
  return src && !failed ? (
    <img
      src={src}
      alt={asset.title}
      loading={large ? 'eager' : 'lazy'}
      onError={() => setFailed(true)}
      draggable={false}
    />
  ) : (
    <div className={`board-link-preview ${failed ? 'is-unavailable' : ''}`}>
      {failed ? <ImageIcon size={28} strokeWidth={1.3} /> : <Link size={29} strokeWidth={1.3} />}
      <strong>{failed ? 'Image unavailable' : sourceName(asset.sourceUrl)}</strong>
      <span>{failed ? 'Open the source to view this reference' : 'Website reference'}</span>
    </div>
  );
}

export default function BoardWorkspace({
  project,
  onChange,
  onToast,
  mode,
  onGenerate,
  helperOnline,
  onAddAsset,
  focusAsset,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedCommentId, setSelectedCommentId] = useState<string>();
  const [target, setTarget] = useState<AnnotationTarget>();
  const [addingComment, setAddingComment] = useState(false);
  const [showPins, setShowPins] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<'upload' | 'link'>('upload');
  const [importUrl, setImportUrl] = useState('');
  const [importTitle, setImportTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyCommented, setOnlyCommented] = useState(false);
  const [direction, setDirection] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<{ assetId: string; value: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const addDialogRef = useRef<HTMLDialogElement>(null);
  const viewerRef = useRef<HTMLDialogElement>(null);
  const projectRef = useRef(project);
  const mountedRef = useRef(true);
  const transfersRef = useRef(new Set<AbortController>());
  const handledFocusRequest = useRef<number | undefined>(undefined);
  projectRef.current = project;
  const screenshots = mode === 'screenshot';
  const assets = project.assets.filter((asset) => asset.kind === mode);
  const selected = assets.find((asset) => asset.id === selectedId);
  const sourceValue =
    sourceDraft?.assetId === selected?.id ? sourceDraft?.value || '' : selected?.sourceUrl || '';
  const sourceInvalid = Boolean(
    sourceValue.trim() &&
    (!safeLink(sourceValue.trim()) || !sourceValue.trim().toLowerCase().startsWith('https://')),
  );
  const selectedIndex = assets.findIndex((asset) => asset.id === selectedId);
  const comments = project.comments.filter((comment) => comment.target.assetId === selected?.id);
  const visible = assets.filter(
    (asset) =>
      (!onlyCommented || project.comments.some((comment) => comment.target.assetId === asset.id)) &&
      `${asset.title} ${asset.note} ${asset.sourceUrl}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const modeComments = project.comments.filter((comment) =>
    assets.some((asset) => asset.id === comment.target.assetId),
  );

  useEffect(() => {
    mountedRef.current = true;
    setSelectedId(undefined);
    setTarget(undefined);
    setAddingComment(false);
    setSearch('');
    setOnlyCommented(false);
    setBusy(false);
    setAddOpen(false);
    setError('');
    return () => {
      mountedRef.current = false;
      handledFocusRequest.current = undefined;
      if (transfersRef.current.size) {
        for (const controller of transfersRef.current) controller.abort();
        transfersRef.current.clear();
        onToast(
          'Image transfer cancelled because you left this board. Add the image again when you return.',
        );
      }
    };
  }, [mode, project.id]);
  useEffect(() => {
    if (!focusAsset || handledFocusRequest.current === focusAsset.requestId) return;
    handledFocusRequest.current = focusAsset.requestId;
    const asset = project.assets.find(
      (item) => item.id === focusAsset.assetId && item.kind === mode,
    );
    if (!asset) return;
    setAddOpen(false);
    setSearch('');
    setOnlyCommented(false);
    setSelectedId(asset.id);
  }, [focusAsset, mode, project.assets]);
  useEffect(() => {
    const dialog = addDialogRef.current;
    if (addOpen && dialog && !dialog.open) dialog.showModal();
    if (!addOpen && dialog?.open) dialog.close();
  }, [addOpen]);
  useEffect(() => {
    const dialog = viewerRef.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    if (!selected && dialog?.open) dialog.close();
  }, [selected?.id]);
  useEffect(() => {
    setSelectedCommentId(undefined);
    setTarget(undefined);
    setAddingComment(false);
    setConfirmDelete(false);
    setSourceDraft(undefined);
  }, [selectedId]);
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash.startsWith('#requirement-')) setSelectedId(undefined);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  async function receiveAsset(response: Response): Promise<BoardAsset> {
    let data: { asset?: BoardAsset; error?: string };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new Error('The server returned an unexpected response. Please try again.');
    }
    if (!response.ok || !data.asset)
      throw new Error(
        data.error || 'Could not add this reference. Please try another file or URL.',
      );
    return data.asset;
  }
  function addAsset(asset: BoardAsset, projectId: string): boolean {
    if (!mountedRef.current || projectRef.current.id !== projectId) return false;
    if (onAddAsset) return onAddAsset(projectId, asset);
    const next = { ...projectRef.current, assets: [...projectRef.current.assets, asset] };
    projectRef.current = next;
    onChange(next);
    return true;
  }
  async function uploadFiles(files: FileList | File[]) {
    if (busy || !files.length) return;
    if (projectRef.current.assets.length + files.length > 100) {
      onToast(
        'A project can hold up to 100 images and references. Remove a reference before adding more.',
      );
      return;
    }
    setBusy(true);
    setError('');
    let uploaded = 0;
    const projectId = projectRef.current.id;
    const controller = new AbortController();
    transfersRef.current.add(controller);
    try {
      for (const file of Array.from(files)) {
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type))
          throw new Error(
            `${file.name}: use a PNG, JPEG, WebP, or GIF image. SVG uploads are not supported.`,
          );
        if (file.size > 10 * 1024 * 1024)
          throw new Error(`${file.name} is too large. Each image must be 10 MB or less.`);
        const form = new FormData();
        form.set('file', file);
        form.set('kind', mode);
        form.set(
          'title',
          file.name
            .replace(/\.[^.]+$/, '')
            .replaceAll('-', ' ')
            .replaceAll('_', ' '),
        );
        const asset = await receiveAsset(
          await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
            method: 'POST',
            body: form,
            credentials: 'same-origin',
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted || !mountedRef.current) return;
        if (!addAsset(asset, projectId))
          throw new Error('The active project changed. This image was not added to the board.');
        uploaded++;
      }
      setAddOpen(false);
      onToast(
        `${uploaded === 1 ? 'Image' : `${uploaded} images`} added to ${screenshots ? 'implementation review' : 'your moodboard'}.`,
      );
    } catch (cause) {
      if (!controller.signal.aborted && mountedRef.current) {
        const message = cause instanceof Error ? cause.message : 'Upload failed. Please try again.';
        setError(message);
        setAddOpen(true);
        onToast(message);
      }
    } finally {
      transfersRef.current.delete(controller);
      if (!controller.signal.aborted && mountedRef.current) {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    }
  }
  async function importReference(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (projectRef.current.assets.length >= 100) {
      setError(
        'A project can hold up to 100 images and references. Remove a reference before adding more.',
      );
      return;
    }
    const url = safeLink(importUrl.trim());
    if (!url || !url.startsWith('https://')) {
      setError('Use a full HTTPS image or webpage URL.');
      return;
    }
    setBusy(true);
    setError('');
    const projectId = projectRef.current.id;
    const controller = new AbortController();
    transfersRef.current.add(controller);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/import`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: importTitle.trim() || undefined, kind: mode }),
        signal: controller.signal,
      });
      const asset = await receiveAsset(response);
      if (controller.signal.aborted || !mountedRef.current) return;
      if (!addAsset(asset, projectId))
        throw new Error('The active project changed. This reference was not added to the board.');
      setAddOpen(false);
      setImportUrl('');
      setImportTitle('');
      onToast(
        asset.imageUrl
          ? 'Image reference added.'
          : 'Website reference added. Upload an image to annotate a specific visual.',
      );
    } catch (cause) {
      if (!controller.signal.aborted && mountedRef.current)
        setError(cause instanceof Error ? cause.message : 'Could not import that link.');
    } finally {
      transfersRef.current.delete(controller);
      if (!controller.signal.aborted && mountedRef.current) setBusy(false);
    }
  }
  function updateAsset(asset: BoardAsset, update: Partial<BoardAsset>) {
    const latest = projectRef.current;
    const next = {
      ...latest,
      assets: latest.assets.map((item) => (item.id === asset.id ? { ...item, ...update } : item)),
    };
    projectRef.current = next;
    onChange(next);
  }
  function closeReference() {
    if (selected && !selected.title.trim()) updateAsset(selected, { title: 'Untitled reference' });
    if (sourceInvalid) onToast('The source URL was incomplete. Your previous source was kept.');
    setSelectedId(undefined);
  }
  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  }
  function openAdd(tab: 'upload' | 'link' = 'upload') {
    setError('');
    setAddTab(tab);
    setAddOpen(true);
  }

  return (
    <section
      className={`board-workspace ${screenshots ? 'is-review' : ''}`}
      aria-label={screenshots ? 'Implementation review' : 'Moodboard'}
    >
      <div className="board-heading">
        <div>
          <div className="board-eyebrow">
            {screenshots ? 'CLOSE THE LOOP' : 'A SHARED VISUAL LANGUAGE'}
          </div>
          <h1>{screenshots ? 'From intention to implementation.' : 'Collect the feeling.'}</h1>
          <p>
            {screenshots
              ? 'Bring the built product back. Pin feedback and turn it into the next clear step.'
              : 'Gather references, capture what matters, and give your product a direction.'}
          </p>
        </div>
        <button type="button" className="board-button board-primary" onClick={() => openAdd()}>
          <Plus size={15} />
          {screenshots ? 'Add screenshots' : 'Add reference'}
        </button>
      </div>
      <div className="board-toolbar">
        <div className="board-filter-tabs">
          <button
            type="button"
            className={!onlyCommented ? 'is-active' : ''}
            onClick={() => setOnlyCommented(false)}
          >
            {screenshots ? 'All screenshots' : 'All references'} <span>{assets.length}</span>
          </button>
          <button
            type="button"
            className={onlyCommented ? 'is-active' : ''}
            onClick={() => setOnlyCommented(true)}
          >
            <MessageCircle size={13} />
            With comments
          </button>
        </div>
        <label className="board-search">
          <Search size={14} />
          <input
            aria-label={screenshots ? 'Search screenshots' : 'Search references'}
            placeholder="Find a reference…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="board-main-layout">
        <div
          className={`board-collection ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={handleDrop}
        >
          {assets.length === 0 ? (
            <div className="board-empty">
              <div className="board-empty-illustration">
                <div />
                <div />
                <span>
                  {screenshots ? (
                    <MousePointer2 size={33} strokeWidth={1.2} />
                  ) : (
                    <Images size={35} strokeWidth={1.2} />
                  )}
                </span>
              </div>
              <h2>
                {screenshots
                  ? 'Make the next iteration specific.'
                  : 'Every great direction starts somewhere.'}
              </h2>
              <p>
                {screenshots
                  ? 'Upload a screenshot of the built product. Click a location to leave feedback, then accept the changes you want Codex to make.'
                  : 'A typeface you love. A layout that feels right. A little inspiration to make your product feel like yours.'}
              </p>
              <button
                type="button"
                className="board-button board-primary"
                onClick={() => openAdd()}
              >
                <Upload size={14} />
                {screenshots ? 'Upload your first screenshot' : 'Add your first reference'}
              </button>
              {!screenshots && (
                <button type="button" className="board-text-button" onClick={() => openAdd('link')}>
                  <Link size={12} />
                  Or paste a link
                </button>
              )}
              <span className="board-empty-tip">
                You can also drop images here · up to 10 MB each
              </span>
            </div>
          ) : visible.length === 0 ? (
            <div className="board-search-empty">
              <Search size={25} />
              <h3>No matching references</h3>
              <p>Try a different search or show all references.</p>
              <button
                type="button"
                className="board-button"
                onClick={() => {
                  setSearch('');
                  setOnlyCommented(false);
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="board-grid">
              {visible.map((asset, index) => {
                const assetComments = project.comments.filter(
                  (comment) => comment.target.assetId === asset.id,
                );
                return (
                  <button
                    type="button"
                    key={asset.id}
                    className={`board-card board-card-${index % 5}`}
                    onClick={() => setSelectedId(asset.id)}
                    aria-label={`Open ${asset.title}`}
                  >
                    <div className="board-card-visual">
                      <AssetImage asset={asset} />
                      <span className="board-card-open">
                        <ZoomIn size={15} />
                      </span>
                      {assetComments.length > 0 && (
                        <span className="board-card-comments">
                          <MessageCircle size={11} />
                          {assetComments.length}
                        </span>
                      )}
                    </div>
                    <div className="board-card-details">
                      <strong>{asset.title}</strong>
                      <span>
                        {sourceName(asset.sourceUrl)}
                        <ArrowUpRight size={11} />
                      </span>
                      {asset.note && <p>{asset.note}</p>}
                    </div>
                  </button>
                );
              })}
              <button type="button" className="board-add-card" onClick={() => openAdd()}>
                <span>
                  <Plus size={20} strokeWidth={1.4} />
                </span>
                <strong>{screenshots ? 'Add a screenshot' : 'A little more inspiration'}</strong>
                <small>Upload an image or paste a link</small>
              </button>
            </div>
          )}
          {dragging && (
            <div className="board-drop-overlay">
              <Upload size={32} />
              <strong>Drop your images here</strong>
            </div>
          )}
        </div>
        <aside className="board-context">
          <div className="board-context-label">
            {screenshots ? 'REVIEW WITH INTENTION' : 'DESIGN DIRECTION'}
          </div>
          {screenshots ? (
            <>
              <div className="board-context-icon">
                <MousePointer2 size={20} />
              </div>
              <h2>
                Small details.
                <br />
                Better outcomes.
              </h2>
              <p>
                Connect the real product to the original intent. Feedback stays attached to the
                place it belongs.
              </p>
              <ol className="board-review-steps">
                <li>
                  <span>1</span>Upload a screenshot
                </li>
                <li>
                  <span>2</span>Pin a comment to the design
                </li>
                <li>
                  <span>3</span>Accept it as a requirement
                </li>
                <li>
                  <span>4</span>Include it in your next handoff
                </li>
              </ol>
              <div className="board-review-count">
                <strong>
                  {modeComments.filter((comment) => comment.status === 'accepted').length}
                </strong>
                <span>
                  decisions ready for
                  <br />
                  your next iteration
                </span>
                <Check size={17} />
              </div>
            </>
          ) : (
            <>
              <div
                className="board-palette"
                id="design-direction"
                aria-label="Current project color palette"
              >
                {[
                  project.design.accent,
                  project.design.background,
                  project.design.surface,
                  project.design.text,
                ].map((color, index) => (
                  <span key={index} style={{ background: color }} title={color} />
                ))}
              </div>
              <h2>
                Make it feel
                <br />
                like your product.
              </h2>
              <p>
                Ask Codex to connect your plan and references into a written visual direction and
                proposed design tokens.
              </p>
              <label className="board-direction-label" htmlFor="board-direction">
                A little guidance
              </label>
              <textarea
                id="board-direction"
                rows={4}
                maxLength={4000}
                placeholder="Warm and thoughtful, with spacious layouts and a quiet confidence…"
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
              />
              <button
                type="button"
                className="board-button board-direction-button"
                disabled={!helperOnline}
                title={
                  helperOnline
                    ? 'Generate a proposal for you to review'
                    : 'Connect your Codex helper in Settings to generate a direction'
                }
                onClick={() =>
                  onGenerate(
                    'moodboard.direction',
                    direction.trim() ||
                      'Create a coherent visual direction and design token proposal from the product plan, moodboard references, their notes, and accepted annotations. Explain how the direction serves the intended audience.',
                  )
                }
              >
                <Sparkles size={14} />
                Explore a direction
              </button>
              <div className="board-ai-note">
                <span className={helperOnline ? 'is-online' : ''} />
                {helperOnline
                  ? 'You review every proposal before applying.'
                  : 'Connect your Codex helper to explore with AI.'}
              </div>
              <div className="board-image-note">
                <ImageIcon size={14} />
                <p>
                  Image generation depends on your Codex helper. You can add image references now.
                </p>
              </div>
            </>
          )}
        </aside>
      </div>
      <input
        ref={inputRef}
        className="board-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        aria-label="Upload reference images"
        onChange={(event) => {
          if (event.target.files) void uploadFiles(event.target.files);
        }}
      />
      <dialog
        ref={addDialogRef}
        className="board-add-dialog"
        aria-label={screenshots ? 'Add a screenshot' : 'Add a reference'}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setAddOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) setAddOpen(false);
        }}
      >
        <div className="board-dialog-header">
          <div>
            <div className="board-eyebrow">
              {screenshots ? 'IMPLEMENTATION REVIEW' : 'GATHER INSPIRATION'}
            </div>
            <h2>{screenshots ? 'Add a screenshot' : 'Add a reference'}</h2>
          </div>
          <button
            type="button"
            className="board-icon-button"
            aria-label="Close add reference"
            onClick={() => setAddOpen(false)}
            disabled={busy}
          >
            <X size={19} />
          </button>
        </div>
        <div className="board-add-tabs">
          <button
            type="button"
            className={addTab === 'upload' ? 'is-active' : ''}
            onClick={() => {
              setAddTab('upload');
              setError('');
            }}
          >
            <Upload size={14} />
            Upload images
          </button>
          <button
            type="button"
            className={addTab === 'link' ? 'is-active' : ''}
            onClick={() => {
              setAddTab('link');
              setError('');
            }}
          >
            <Link size={14} />
            Paste a link
          </button>
        </div>
        {addTab === 'upload' ? (
          <div
            className="board-upload-zone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <span>
              <Upload size={27} strokeWidth={1.4} />
            </span>
            <h3>{busy ? 'Adding your images…' : 'Drop something inspiring here'}</h3>
            <p>PNG, JPEG, WebP, or GIF · 10 MB per image</p>
            <button
              type="button"
              className="board-button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <LoaderCircle size={14} className="board-spin" /> : <Plus size={14} />}
              {busy ? 'Uploading' : 'Choose files'}
            </button>
          </div>
        ) : (
          <form className="board-link-form" onSubmit={(event) => void importReference(event)}>
            <label htmlFor="board-import-url">Image or webpage URL</label>
            <input
              id="board-import-url"
              type="url"
              placeholder="https://example.com/something-inspiring"
              required
              value={importUrl}
              disabled={busy}
              onChange={(event) => setImportUrl(event.target.value)}
            />
            <p>
              Direct image links are saved to your board. Webpages are kept as source references.
            </p>
            <label htmlFor="board-import-title">
              Title <span>optional</span>
            </label>
            <input
              id="board-import-title"
              placeholder="What caught your eye?"
              maxLength={200}
              value={importTitle}
              disabled={busy}
              onChange={(event) => setImportTitle(event.target.value)}
            />
            <button
              type="submit"
              className="board-button board-primary"
              disabled={busy || !importUrl.trim()}
            >
              {busy ? <LoaderCircle size={14} className="board-spin" /> : <Plus size={14} />}
              {busy ? 'Adding reference…' : 'Add to board'}
            </button>
          </form>
        )}
        {error && (
          <div className="board-error" role="alert">
            {error}
          </div>
        )}
        <div className="board-dialog-footnote">
          <MessageCircle size={13} />
          Open any reference to add notes and pinned comments.
        </div>
      </dialog>
      <dialog
        ref={viewerRef}
        className="board-viewer"
        aria-label={selected ? `Reference: ${selected.title || 'Untitled reference'}` : 'Reference'}
        onCancel={closeReference}
      >
        {selected && (
          <>
            <div className="board-viewer-header">
              <div>
                <span className="board-viewer-symbol">
                  {screenshots ? <MousePointer2 size={16} /> : <Images size={16} />}
                </span>
                <strong>{selected.title}</strong>
                <span className="board-viewer-position">
                  {selectedIndex + 1} of {assets.length}
                </span>
              </div>
              <div className="board-viewer-controls">
                <button
                  type="button"
                  className="board-icon-button"
                  disabled={selectedIndex <= 0}
                  aria-label="Previous reference"
                  onClick={() => setSelectedId(assets[selectedIndex - 1]?.id)}
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  type="button"
                  className="board-icon-button"
                  disabled={selectedIndex >= assets.length - 1}
                  aria-label="Next reference"
                  onClick={() => setSelectedId(assets[selectedIndex + 1]?.id)}
                >
                  <ChevronRight size={17} />
                </button>
                <span className="board-control-divider" />
                <button
                  type="button"
                  className="board-icon-button"
                  aria-label="Close reference"
                  onClick={closeReference}
                >
                  <X size={19} />
                </button>
              </div>
            </div>
            <div className="board-viewer-body">
              <div className="board-viewer-content">
                <div className="board-image-toolbar">
                  <button
                    type="button"
                    className={`board-button board-small ${addingComment ? 'is-selected' : ''}`}
                    onClick={() => {
                      setAddingComment(!addingComment);
                      setShowPins(true);
                    }}
                  >
                    <MessageCircle size={13} />
                    {addingComment ? 'Click a location…' : 'Pin a comment'}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={showPins}
                      onChange={(event) => setShowPins(event.target.checked)}
                    />
                    Show comments
                  </label>
                  {selected.imageUrl && usableImage(selected.imageUrl) && (
                    <a
                      href={usableImage(selected.imageUrl)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open original image"
                    >
                      <ArrowDownToLine size={14} />
                      Original
                    </a>
                  )}
                </div>
                <div className="board-image-stage">
                  <div
                    className={`board-image-wrapper ${selected.imageUrl ? '' : 'is-web-reference'}`}
                  >
                    <AssetImage key={selected.id} asset={selected} large />
                    {showPins && (
                      <AnnotationOverlay
                        comments={comments.filter((comment) => comment.status !== 'resolved')}
                        selectedId={selectedCommentId}
                        adding={addingComment}
                        onSelect={(comment) => {
                          setSelectedCommentId(comment.id);
                          setAddingComment(false);
                          setTarget(undefined);
                        }}
                        onAdd={(x, y) => {
                          setTarget({ kind: 'asset', assetId: selected.id, x, y });
                          setAddingComment(false);
                          setSelectedCommentId(undefined);
                        }}
                      />
                    )}
                  </div>
                </div>
                {addingComment && (
                  <div className="board-pinning-hint">
                    <span />
                    Click anywhere on the reference to pin your comment.
                  </div>
                )}
                <div className="board-asset-fields" key={`fields-${selected.id}`}>
                  <div className="board-asset-title-row">
                    <label>
                      Reference title
                      <input
                        aria-label="Reference title"
                        value={selected.title}
                        maxLength={200}
                        onChange={(event) => updateAsset(selected, { title: event.target.value })}
                        onBlur={(event) => {
                          const title = event.target.value.trim() || 'Untitled reference';
                          if (title !== selected.title) updateAsset(selected, { title });
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className={`board-icon-button ${confirmDelete ? 'is-danger' : ''}`}
                      aria-label={confirmDelete ? 'Confirm remove reference' : 'Remove reference'}
                      title={
                        confirmDelete
                          ? 'Click again to remove this reference; its notes stay in the project discussion'
                          : 'Remove reference'
                      }
                      onClick={() => {
                        if (!confirmDelete) {
                          setConfirmDelete(true);
                          return;
                        }
                        onChange({
                          ...project,
                          assets: project.assets.filter((asset) => asset.id !== selected.id),
                        });
                        setSelectedId(undefined);
                        onToast(
                          'Reference removed. Its comments and requirements are kept in the project discussion.',
                        );
                      }}
                    >
                      <Trash2 size={16} />
                      {confirmDelete && <span>Remove?</span>}
                    </button>
                  </div>
                  <label>
                    What matters here
                    <textarea
                      aria-label="Reference note"
                      rows={2}
                      value={selected.note}
                      maxLength={10000}
                      placeholder="The generous spacing, the warm palette, the way the typography feels…"
                      onChange={(event) => updateAsset(selected, { note: event.target.value })}
                    />
                  </label>
                  <div className="board-source-field">
                    <label>
                      Source URL
                      <input
                        aria-label="Reference source URL"
                        type="url"
                        value={sourceValue}
                        aria-invalid={sourceInvalid || undefined}
                        aria-describedby={sourceInvalid ? 'board-source-error' : undefined}
                        placeholder="https://…"
                        maxLength={2000}
                        onChange={(event) => {
                          const sourceUrl = event.target.value.trim();
                          if (
                            sourceUrl &&
                            (!safeLink(sourceUrl) ||
                              !sourceUrl.toLowerCase().startsWith('https://'))
                          ) {
                            setSourceDraft({ assetId: selected.id, value: event.target.value });
                            return;
                          }
                          setSourceDraft(undefined);
                          if (sourceUrl !== selected.sourceUrl)
                            updateAsset(selected, { sourceUrl });
                        }}
                      />
                      {sourceInvalid && (
                        <span id="board-source-error" role="status">
                          Use a full https:// URL. Your previous source is kept until this is valid.
                        </span>
                      )}
                    </label>
                    {safeLink(selected.sourceUrl) && (
                      <a
                        href={safeLink(selected.sourceUrl)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open reference source"
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <AnnotationPanel
                key={selected.id}
                project={project}
                onChange={onChange}
                onToast={onToast}
                target={target}
                filter={{ assetId: selected.id }}
                selectedId={selectedCommentId}
              />
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
