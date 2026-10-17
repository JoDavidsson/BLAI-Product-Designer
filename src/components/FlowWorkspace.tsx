import { useEffect, useRef, useState } from 'react';
import { enableZoom } from 'pele/core';
import { AlertCircle, ArrowRight, Check, Copy, GitBranch, Plus, Route, Trash2 } from 'lucide-react';
import {
  MAX_DIAGRAMS,
  MAX_DIAGRAM_SOURCE_LENGTH,
  uid,
  type ProductDiagram,
  type Project,
} from '../../shared/model';
import { DIAGRAM_STARTERS, renderProductDiagram } from '../lib/diagrams';
import './flows.css';

export default function FlowWorkspace({
  project,
  onChange,
  onToast,
}: {
  project: Project;
  onChange: (project: Project) => void;
  onToast: (message: string) => void;
}) {
  const diagrams = project.diagrams ?? [];
  const [selectedId, setSelectedId] = useState(diagrams[0]?.id ?? '');
  const selected = diagrams.find((item) => item.id === selectedId) ?? diagrams[0];
  const full = diagrams.length >= MAX_DIAGRAMS;

  function add(kind: ProductDiagram['kind']) {
    if (full) return;
    const diagram = { id: uid('diagram'), kind, ...DIAGRAM_STARTERS[kind] };
    onChange({ ...project, diagrams: [...diagrams, diagram] });
    setSelectedId(diagram.id);
  }
  function update(diagram: ProductDiagram) {
    onChange({
      ...project,
      diagrams: diagrams.map((item) => (item.id === diagram.id ? diagram : item)),
    });
  }
  function duplicate() {
    if (!selected || full) return;
    const diagram = {
      ...selected,
      id: uid('diagram'),
      title: `${selected.title.slice(0, 113)} (copy)`,
    };
    onChange({ ...project, diagrams: [...diagrams, diagram] });
    setSelectedId(diagram.id);
  }
  function remove() {
    if (!selected) return;
    const remaining = diagrams.filter((item) => item.id !== selected.id);
    onChange({ ...project, diagrams: remaining });
    setSelectedId(remaining[0]?.id ?? '');
    onToast('Diagram removed. Use Undo to bring it back.');
  }

  return (
    <div className="flow-workspace">
      <header className="flow-heading">
        <div>
          <div className="eyebrow">
            CONNECT THE EXPERIENCE <span className="flow-experiment">PELE EXPERIMENT</span>
          </div>
          <h1>See how it all connects.</h1>
          <p>Map the journey, the decisions, and what happens in between.</p>
        </div>
        <div className="flow-create-actions">
          <button className="btn outlined" disabled={full} onClick={() => add('state')}>
            <Plus size={14} /> New screen states
          </button>
          <button className="btn primary" disabled={full} onClick={() => add('flowchart')}>
            <Plus size={14} /> New user flow
          </button>
        </div>
      </header>
      {full && (
        <p className="flow-limit" role="status">
          All {MAX_DIAGRAMS} diagram spaces are in use. Remove a diagram to add another.
        </p>
      )}
      {selected ? (
        <>
          <nav className="flow-tabs" aria-label="Project diagrams">
            {diagrams.map((diagram) => (
              <button
                key={diagram.id}
                aria-pressed={selected.id === diagram.id}
                onClick={() => setSelectedId(diagram.id)}
              >
                {diagram.kind === 'flowchart' ? <Route size={15} /> : <GitBranch size={15} />}
                <span>{diagram.title}</span>
              </button>
            ))}
          </nav>
          <section className="flow-editor">
            <div className="flow-source-panel">
              <div className="flow-panel-heading">
                <span>THE BLUEPRINT</span>
                <span className="flow-language">Mermaid</span>
              </div>
              <DiagramName
                key={selected.id}
                title={selected.title}
                onChange={(title) => update({ ...selected, title })}
              />
              <div className="flow-source-label">
                <label htmlFor="diagram-source">
                  {selected.kind === 'flowchart' ? 'User flow' : 'Screen states'} source
                </label>
                <span>
                  Live preview <span className="flow-live-dot" />
                </span>
              </div>
              <textarea
                id="diagram-source"
                aria-describedby="flow-source-help"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={MAX_DIAGRAM_SOURCE_LENGTH}
                value={selected.source}
                onChange={(event) => update({ ...selected, source: event.target.value })}
              />
              <div className="flow-editor-meta">
                <span>Edits save with your project</span>
                <span>{selected.source.length.toLocaleString()} / 12,000</span>
              </div>
              <details className="flow-syntax" id="flow-source-help">
                <summary>A little syntax goes a long way</summary>
                <p>
                  {selected.kind === 'flowchart'
                    ? 'Use A[Screen name] for a step, B{A decision?} for a choice, and A --> B to connect them. Add |Yes| after an arrow to label it.'
                    : 'Use Loading --> Ready: Data found to describe a transition. [*] marks the start or end of a journey.'}
                </p>
                <p>These are editable examples. Adapt them to your product’s real behavior.</p>
              </details>
              <div className="flow-source-actions">
                <button className="btn subtle small" disabled={full} onClick={duplicate}>
                  <Copy size={14} /> Duplicate
                </button>
                <button className="btn subtle small" aria-label="Delete diagram" onClick={remove}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
            <DiagramPreview key={selected.id} diagram={selected} />
          </section>
          <footer className="flow-footer">
            <div>
              <CodeBadge />
              <span>
                <strong>A shared language for you and Codex.</strong> Your diagram source is
                included in the handoff package.
              </span>
            </div>
            <span className="flow-footer-note">Mermaid → Pele → SVG</span>
          </footer>
        </>
      ) : (
        <section className="flow-empty">
          <span className="flow-empty-icon">
            <Route size={28} />
          </span>
          <h2>Every great product has a path.</h2>
          <p>
            Start with an editable example. Connect the steps people take, or describe how a screen
            responds.
          </p>
          <div className="flow-starters">
            <button onClick={() => add('flowchart')}>
              <Route size={23} />
              <strong>User flow</strong>
              <span>Steps, decisions, and routes to a goal.</span>
              <span className="flow-start-link">
                Start a user flow <ArrowRight size={15} />
              </span>
            </button>
            <button onClick={() => add('state')}>
              <GitBranch size={23} />
              <strong>Screen states</strong>
              <span>Loading, empty, error, and success.</span>
              <span className="flow-start-link">
                Start screen states <ArrowRight size={15} />
              </span>
            </button>
          </div>
          <small>Rendered locally with Pele. No AI connection needed.</small>
        </section>
      )}
    </div>
  );
}

function CodeBadge() {
  return <span className="flow-code-badge">{'{ }'}</span>;
}

function DiagramName({ title, onChange }: { title: string; onChange: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  return (
    <label className="flow-title-label">
      Diagram name
      <input
        aria-label="Diagram name"
        maxLength={120}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (event.target.value.trim()) onChange(event.target.value);
        }}
        onBlur={() => {
          if (!draft.trim()) setDraft(title);
        }}
      />
    </label>
  );
}

function DiagramPreview({ diagram }: { diagram: ProductDiagram }) {
  const [preview, setPreview] = useState<{ source: string; svg?: string; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      await document.fonts.ready;
      if (cancelled) return;
      try {
        const result = renderProductDiagram(diagram);
        setPreview({ source: diagram.source, svg: result.svg });
      } catch (error) {
        setPreview({
          source: diagram.source,
          error: error instanceof Error ? error.message : 'This diagram could not be drawn.',
        });
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [diagram.id, diagram.kind, diagram.source]);
  const pending = preview?.source !== diagram.source;
  return (
    <div className="flow-preview-panel">
      <div className="flow-panel-heading">
        <span>THE EXPERIENCE</span>
        <span className="flow-render-status" role="status">
          {pending ? (
            'Updating…'
          ) : preview?.error ? (
            'Check your source'
          ) : (
            <>
              <Check size={12} /> Preview ready
            </>
          )}
        </span>
      </div>
      <div className="flow-preview-title">
        <span>{diagram.kind === 'flowchart' ? 'USER JOURNEY' : 'SCREEN BEHAVIOR'}</span>
        <h2>{diagram.title}</h2>
        <p>
          {diagram.kind === 'flowchart'
            ? 'One path. Every decision considered.'
            : 'Make the in-between moments explicit.'}
        </p>
      </div>
      <div className={`flow-preview-canvas ${pending ? 'is-updating' : ''}`} aria-busy={pending}>
        {preview?.error ? (
          <div className="flow-render-error" role="alert">
            <AlertCircle size={23} />
            <strong>Let’s untangle this.</strong>
            <pre>{preview.error}</pre>
            <p>Your source is kept. Fix it above to refresh the preview.</p>
          </div>
        ) : preview?.svg ? (
          <PeleSvg svg={preview.svg} label={`${diagram.title} diagram`} />
        ) : (
          <p className="flow-render-placeholder">Drawing your diagram…</p>
        )}
      </div>
      <div className="flow-preview-footer">
        <span>
          <i /> {diagram.kind === 'flowchart' ? 'Steps & decisions' : 'States & transitions'}
        </span>
        <span>
          Rendered with <strong>Pele</strong>
        </span>
      </div>
    </div>
  );
}

function PeleSvg({ svg, label }: { svg: string; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // This subtree belongs to Pele, including its zoom controls and listeners.
    element.innerHTML = svg;
    const zoom = enableZoom(element, { always: true });
    return () => {
      zoom.destroy();
      element.replaceChildren();
    };
  }, [svg]);
  return (
    <div
      ref={container}
      className="flow-svg"
      role="group"
      aria-label={label}
      title="Zoom with + / − or Ctrl/⌘ + scroll. Drag to pan; 0 resets the view."
    />
  );
}
