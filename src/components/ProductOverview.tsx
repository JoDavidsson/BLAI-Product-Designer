import { useEffect, useMemo, useRef, useState } from 'react';
import { enableZoom } from 'pele/core';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  FileText,
  GitBranch,
  Layers3,
  MessageSquare,
  Network,
  RefreshCw,
  Route,
} from 'lucide-react';
import type { Project } from '../../shared/model';
import {
  buildProductOverview,
  type OverviewGraph,
  type OverviewNode,
  type OverviewSource,
} from '../../shared/overview';
import { renderOverviewGraph } from '../lib/diagrams';
import './overview.css';

const views = [
  { id: 'product', title: 'Product map', icon: Network },
  { id: 'journey', title: 'Written journey', icon: Route },
  { id: 'screens', title: 'Screen connections', icon: GitBranch },
] as const;
const sessionKey = (id: string) => `blai-overview-enabled:${id}`;
function wasOpened(id: string) {
  try {
    return sessionStorage.getItem(sessionKey(id)) === 'true';
  } catch {
    return false;
  }
}
const sourceNames: Record<OverviewSource['kind'], string> = {
  project: 'Open product plan',
  plan: 'Open plan section',
  screen: 'Open wireframe',
  requirement: 'Open requirement',
  comment: 'Open discussion',
  asset: 'Open reference',
  chat: 'Open conversation',
  design: 'Open visual direction',
};
export default function ProductOverview({
  project,
  onNavigate,
  visualizeRequest,
}: {
  project: Project;
  onNavigate: (source: OverviewSource) => void;
  visualizeRequest?: { projectId: string; requestId: number };
}) {
  const [enabled, setEnabled] = useState(() => wasOpened(project.id));
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<OverviewGraph['id']>('product');
  const [selectedId, setSelectedId] = useState('');
  const overview = useMemo(
    () => (enabled ? buildProductOverview(project) : null),
    [enabled, project, refresh],
  );
  const graph = overview?.graphs.find((item) => item.id === view);
  const selected = graph?.nodes.find((item) => item.id === selectedId) ?? graph?.nodes[0];
  function visualize() {
    setEnabled(true);
    setRefresh((value) => value + 1);
    try {
      sessionStorage.setItem(sessionKey(project.id), 'true');
    } catch {
      /* Optional preference. */
    }
  }
  useEffect(() => {
    if (visualizeRequest?.projectId === project.id) {
      setEnabled(true);
      try {
        sessionStorage.setItem(sessionKey(project.id), 'true');
      } catch {
        /* Optional preference. */
      }
    }
  }, [visualizeRequest, project.id]);
  return (
    <div className="overview-workspace">
      <header className="overview-heading">
        <div>
          <div className="eyebrow">
            THE BIG PICTURE <span className="overview-badge">AUTOMATIC OVERVIEW</span>
          </div>
          <h1>Your product, at a glance.</h1>
          <p>See the shape of what you’ve already defined.</p>
        </div>
        <button className="btn primary" onClick={visualize}>
          {enabled ? <RefreshCw size={15} /> : <Network size={16} />}
          {enabled ? 'Refresh overview' : 'Visualize product'}
        </button>
      </header>
      {!overview ? (
        <section className="overview-welcome">
          <div className="overview-orbit">
            <FileText size={22} />
            <i />
            <Network size={36} />
            <i />
            <Layers3 size={22} />
          </div>
          <span className="overview-kicker">ONE PROJECT. ANOTHER PERSPECTIVE.</span>
          <h2>Turn your thinking into a picture.</h2>
          <p>
            Your plan, wireframes, decisions, and references become a connected overview. Explore
            what’s there and spot what still needs a connection.
          </p>
          <div className="overview-welcome-points">
            <span>
              <Check size={14} /> Uses your existing work
            </span>
            <span>
              <Check size={14} /> Links back to the source
            </span>
            <span>
              <Check size={14} /> Updates as you edit
            </span>
          </div>
          <p className="overview-welcome-hint">
            Choose “Visualize product” to see your project from a new angle.
          </p>
        </section>
      ) : (
        <>
          <div className="overview-context" aria-label="Included project material">
            <span>
              <FileText size={14} />
              <strong>{overview.stats.planSections}</strong> plan sections
            </span>
            <span>
              <Layers3 size={14} />
              <strong>{overview.stats.screens}</strong> screens
            </span>
            <span>
              <Check size={14} />
              <strong>{overview.stats.requirements}</strong> requirement
              {overview.stats.requirements === 1 ? '' : 's'}
            </span>
            <span>
              <MessageSquare size={14} />
              <strong>{overview.stats.comments}</strong> comment
              {overview.stats.comments === 1 ? '' : 's'}
            </span>
            <span>
              <strong>{overview.stats.assets}</strong> reference
              {overview.stats.assets === 1 ? '' : 's'}
            </span>
            <span>
              <strong>{overview.stats.messages}</strong> message
              {overview.stats.messages === 1 ? '' : 's'}
            </span>
            <span className="overview-current">
              <Check size={12} /> Reflects current project
            </span>
          </div>
          <nav className="overview-tabs" aria-label="Overview views">
            {views.map((item) => (
              <button
                key={item.id}
                aria-pressed={view === item.id}
                onClick={() => {
                  setView(item.id);
                  setSelectedId('');
                }}
              >
                <item.icon size={15} />
                {item.title}
              </button>
            ))}
          </nav>
          {graph && (
            <div className="overview-layout">
              <section className="overview-map" aria-label={graph.title}>
                <div className="overview-map-heading">
                  <div>
                    <span className="overview-kicker">
                      {view === 'product'
                        ? 'HOW YOUR THINKING FITS TOGETHER'
                        : view === 'journey'
                          ? 'THE JOURNEY YOU DESCRIBED'
                          : 'CONNECTIONS ALREADY IN YOUR WIREFRAMES'}
                    </span>
                    <h2>{project.title}</h2>
                  </div>
                  <span className="overview-readonly">Read-only view</span>
                </div>
                <p className="overview-description">{graph.description}</p>
                <OverviewDrawing graph={graph} selectedId={selected?.id} onSelect={setSelectedId} />
                <div className="overview-map-footer">
                  <span>
                    <i />
                    {view === 'screens'
                      ? 'Arrows are defined screen links'
                      : view === 'journey'
                        ? graph.edges.length
                          ? 'Lines follow written order, not screen navigation'
                          : 'Original written journey context'
                        : 'Lines group existing project material'}
                  </span>
                  <span>Click an item to explore</span>
                </div>
              </section>
              <aside className="overview-inspector" aria-label="Overview source details">
                <div className="overview-inspector-heading">
                  <span className="overview-kicker">BEHIND THE PICTURE</span>
                  <h2>Back to the source.</h2>
                  <p>Every detail comes from your project.</p>
                </div>
                <label className="overview-select">
                  Explore an item
                  <select
                    aria-label="Inspect overview item"
                    value={selected?.id ?? ''}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    {graph.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.title}
                      </option>
                    ))}
                  </select>
                </label>
                {selected && (
                  <SourceDetails
                    key={`${graph.id}-${selected.id}`}
                    node={selected}
                    onNavigate={onNavigate}
                  />
                )}
              </aside>
            </div>
          )}
          {graph && graph.notes.length > 0 && (
            <div className="overview-notes">
              {graph.notes.map((note, index) => (
                <p key={index}>{note}</p>
              ))}
            </div>
          )}
          {overview.gaps.length > 0 && (
            <section className="overview-gaps">
              <div>
                <AlertCircle size={17} />
                <h2>Things to look at</h2>
                <span>{overview.gaps.length}</span>
              </div>
              <div className="overview-gap-list">
                {overview.gaps.map((gap) => (
                  <article key={gap.id}>
                    <strong>{gap.title}</strong>
                    <p>{gap.detail}</p>
                    {gap.source && (
                      <button className="text-button" onClick={() => onNavigate(gap.source!)}>
                        {sourceNames[gap.source.kind]} <ArrowUpRight size={13} />
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          <footer className="overview-footer">
            <Network size={15} />
            <p>
              One view of the work you’ve already done. Edit the original material to change the
              picture.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
function SourceDetails({
  node,
  onNavigate,
}: {
  node: OverviewNode;
  onNavigate: (source: OverviewSource) => void;
}) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(8);
  const entries = node.entries.filter((entry) =>
    `${entry.title} ${entry.body} ${entry.status ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="overview-source-details">
      <div className="overview-source-heading">
        <h3>{node.title}</h3>
        <span>
          {node.entries.length} source{node.entries.length === 1 ? '' : 's'}
        </span>
      </div>
      {node.entries.length > 5 && (
        <input
          className="overview-search"
          aria-label="Find source material"
          placeholder="Find source material…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(8);
          }}
        />
      )}
      {entries.length === 0 && (
        <p className="overview-no-sources">
          {node.entries.length
            ? 'No matching source material.'
            : 'Nothing has been defined here yet. Add details in the product plan or wireframes.'}
        </p>
      )}
      {entries.slice(0, limit).map((entry) => (
        <details
          className="overview-source-card"
          key={entry.id}
          open={entries.length === 1 ? true : undefined}
        >
          <summary>
            <span>{entry.title}</span>
            {entry.status && (
              <small className={`overview-source-status status-${entry.status}`}>
                {entry.status}
              </small>
            )}
          </summary>
          <div>
            <p>{entry.body || 'No details written yet.'}</p>
            <button className="text-button" onClick={() => onNavigate(entry.source)}>
              {sourceNames[entry.source.kind]}
              <ArrowUpRight size={13} />
            </button>
          </div>
        </details>
      ))}
      {entries.length > limit && (
        <button className="btn outlined small" onClick={() => setLimit((value) => value + 8)}>
          Show more sources ({entries.length - limit})
        </button>
      )}
    </div>
  );
}
function OverviewDrawing({
  graph,
  selectedId,
  onSelect,
}: {
  graph: OverviewGraph;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'drawing' | 'ready' | 'error'>('drawing');
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    let cleanup = () => {};
    setState('drawing');
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      try {
        const result = renderOverviewGraph(graph);
        element.innerHTML = result.svg;
        const select = (event: Event) => {
          const target =
            event.target instanceof Element ? event.target.closest('[data-overview-node]') : null;
          const id = target?.getAttribute('data-id');
          if (id) onSelect(id);
        };
        let pointerStart = { x: 0, y: 0 };
        const pointer = (event: PointerEvent) => {
          pointerStart = { x: event.clientX, y: event.clientY };
        };
        const click = (event: MouseEvent) => {
          if (
            event.detail === 0 ||
            Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 6
          )
            select(event);
        };
        const key = (event: KeyboardEvent) => {
          if (
            (event.key === 'Enter' || event.key === ' ') &&
            event.target instanceof Element &&
            event.target.hasAttribute('data-overview-node')
          ) {
            event.preventDefault();
            event.stopPropagation();
            select(event);
          }
        };
        for (const node of graph.nodes) {
          const target = element.querySelector<SVGElement>(`.pele-node[data-id="${node.id}"]`);
          if (!target) continue;
          target.setAttribute('data-overview-node', 'true');
          target.setAttribute('tabindex', '0');
          target.setAttribute('role', 'button');
          target.setAttribute('aria-label', `Inspect ${node.title}`);
        }
        element.addEventListener('pointerdown', pointer);
        element.addEventListener('click', click);
        element.addEventListener('keydown', key);
        const zoom = enableZoom(element, { always: true });
        cleanup = () => {
          zoom.destroy();
          element.removeEventListener('pointerdown', pointer);
          element.removeEventListener('click', click);
          element.removeEventListener('keydown', key);
          element.replaceChildren();
        };
        setState('ready');
      } catch {
        element.replaceChildren();
        setState('error');
      }
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [graph, onSelect]);
  useEffect(() => {
    for (const node of container.current?.querySelectorAll('[data-overview-node]') ?? []) {
      const selected = node.getAttribute('data-id') === selectedId;
      node.setAttribute('aria-pressed', String(selected));
      node.classList.toggle('overview-node-selected', selected);
    }
  }, [selectedId, graph, state]);
  return (
    <div className="overview-drawing">
      <span className="overview-render-status" role="status">
        {state === 'drawing'
          ? 'Drawing your overview…'
          : state === 'ready'
            ? 'Overview ready'
            : 'The picture could not be drawn. Refresh the overview to try again; all source material is still available beside it.'}
      </span>
      <div
        ref={container}
        className="overview-svg"
        role="group"
        aria-label={`${graph.title} diagram`}
        aria-busy={state === 'drawing'}
      />
      <p className="overview-zoom-hint">Zoom with + / − · Drag to pan · 0 to reset</p>
    </div>
  );
}
