import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  FileText,
  GitBranch,
  History,
  Image,
  Layers3,
  Loader2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Plus,
  Redo2,
  Undo2,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  WandSparkles,
  X,
} from 'lucide-react';
import type {
  AIJob,
  AIProposal,
  BoardAsset,
  HelperStatus,
  JobKind,
  Project,
  ProjectSummary,
  ProjectVersion,
  WireNode,
} from '../shared/model';
import { PLAN_FIELDS, planCompletion, uid } from '../shared/model';
import { projectSchema } from '../shared/validation';
import { api } from './lib/api';
import { useProject } from './lib/use-project';
import WireframeWorkspace from './components/WireframeWorkspace';
import BoardWorkspace from './components/BoardWorkspace';
import AnnotationPanel from './components/AnnotationPanel';
import ProposalChanges from './components/ProposalChanges';
import AIActivity, { jobStageLabel } from './components/AIActivity';
import type { OverviewSource } from '../shared/overview';
const ProductOverview = lazy(() => import('./components/ProductOverview'));

type View = 'plan' | 'flows' | 'wireframes' | 'moodboard' | 'review' | 'handoff' | 'settings';
const navigation = [
  {
    id: 'plan',
    label: 'Product plan',
    icon: FileText,
    description: 'Give your idea a clear direction',
  },
  { id: 'flows', label: 'Overview', icon: GitBranch, description: 'See the whole product' },
  { id: 'wireframes', label: 'Wireframes', icon: Layers3, description: 'Shape the experience' },
  { id: 'moodboard', label: 'Moodboard', icon: Image, description: 'Find the feeling' },
  { id: 'review', label: 'Build review', icon: MessageSquare, description: 'Close the loop' },
  { id: 'handoff', label: 'Handoff', icon: Code2, description: 'Make it buildable' },
] as const;
const offlineHelper: HelperStatus = {
  online: false,
  lastSeen: null,
  workerId: null,
  protocolVersion: 1,
  capabilities: [],
  imageGeneration: false,
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const helperFailureMessages: Record<string, string> = {
  login: 'Sign in to Codex with ChatGPT on the computer running BLAI Helper, then try again.',
  limit:
    'Your Codex account has reached a usage limit. Check your allowance and try again when it resets.',
  invalid: 'Codex returned a result Designer could not use. Try a smaller, more focused request.',
  timeout: 'Codex took too long to finish. Try a smaller request.',
  unavailable:
    'Codex could not finish this request. Check BLAI Helper on your Linux computer, then try again.',
};
const jobFailureMessage = (job: AIJob) =>
  job.error && Object.hasOwn(helperFailureMessages, job.error)
    ? helperFailureMessages[job.error]
    : job.error || 'The AI request could not be completed.';

export default function App() {
  const {
    project,
    change,
    replace: replaceProject,
    flush,
    saveState,
    saveError,
    current,
    undo: undoProject,
    redo: redoProject,
    canUndo,
    canRedo,
  } = useProject();
  // Async image transfers must not reinsert layers after a history operation or restore.
  const editingEpochRef = useRef(0);
  const [editingEpoch, setEditingEpoch] = useState(0);
  const invalidateTransfers = useCallback(() => {
    editingEpochRef.current += 1;
    setEditingEpoch(editingEpochRef.current);
  }, []);
  const replace = useCallback(
    (...args: Parameters<typeof replaceProject>) => {
      invalidateTransfers();
      replaceProject(...args);
    },
    [invalidateTransfers, replaceProject],
  );
  const undo = useCallback(() => {
    invalidateTransfers();
    undoProject();
  }, [invalidateTransfers, undoProject]);
  const redo = useCallback(() => {
    invalidateTransfers();
    redoProject();
  }, [invalidateTransfers, redoProject]);
  const [view, setView] = useState<View>('plan');
  const [visualizeRequest, setVisualizeRequest] = useState<{
    projectId: string;
    requestId: number;
  }>();
  const [sourceFocus, setSourceFocus] = useState<{
    projectId: string;
    source: OverviewSource;
    requestId: number;
    view: View;
  }>();
  function openOverviewSource(source: OverviewSource) {
    if (!project) return;
    const destination: View =
      source.kind === 'screen'
        ? 'wireframes'
        : source.kind === 'requirement' || source.kind === 'comment'
          ? 'handoff'
          : source.kind === 'design'
            ? 'moodboard'
            : source.kind === 'asset'
              ? project.assets.find((asset) => asset.id === source.assetId)?.kind === 'screenshot'
                ? 'review'
                : 'moodboard'
              : 'plan';
    setSourceFocus((previous) => ({
      projectId: project.id,
      source,
      requestId: (previous?.requestId ?? 0) + 1,
      view: destination,
    }));
    setView(destination);
  }
  useEffect(() => {
    if (!sourceFocus || sourceFocus.projectId !== project?.id || view !== sourceFocus.view) return;
    const source = sourceFocus.source;
    const id =
      source.kind === 'plan'
        ? `plan-${source.key}`
        : source.kind === 'requirement'
          ? `requirement-${source.requirementId}`
          : source.kind === 'comment'
            ? `comment-${source.commentId}`
            : source.kind === 'chat'
              ? `chat-${source.messageId}`
              : source.kind === 'design'
                ? 'design-direction'
                : source.kind === 'project'
                  ? 'product-plan-document'
                  : undefined;
    if (!id) return;
    let target: HTMLElement | null = null;
    const frame = requestAnimationFrame(() => {
      target = document.getElementById(id);
      target?.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (target) {
        target.classList.add('overview-source-focus');
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      target?.classList.remove('overview-source-focus');
    };
  }, [sourceFocus, project?.id, view]);
  const activeSource = sourceFocus?.projectId === project?.id ? sourceFocus : undefined;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [session, setSession] = useState<{
    email: string;
    local: boolean;
    githubConfigured: boolean;
  } | null>(null);
  const [helper, setHelper] = useState<HelperStatus>(offlineHelper);
  const [jobs, setJobs] = useState<AIJob[]>([]);
  const [proposals, setProposals] = useState<AIProposal[]>([]);
  const [bootError, setBootError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<'new' | 'proposals' | 'versions' | 'github' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const transitionLock = useRef(false);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [checkpointName, setCheckpointName] = useState('');
  const [selectedProposal, setSelectedProposal] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [exportPath, setExportPath] = useState('product-spec');
  const [exportResult, setExportResult] = useState('');
  const initialized = useRef(false);
  const reportedJobs = useRef(new Set<string>());
  const observedJobStates = useRef(new Map<string, AIJob['status']>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 6500);
  }, []);

  const refreshProjects = useCallback(async () => {
    const result = await api.projects();
    setProjects(result.projects);
    return result.projects;
  }, []);
  const initialize = useCallback(async () => {
    setBootError('');
    try {
      const identity = await api.session();
      setSession(identity);
      const list = await refreshProjects();
      const savedId = localStorage.getItem('blai-project');
      const selected = list.find((item) => item.id === savedId) || list[0];
      const loaded = selected ? await api.get(selected.id) : await api.create(undefined, true);
      replace(loaded.project);
      if (!selected) await refreshProjects();
    } catch (error) {
      setBootError(errorMessage(error));
    }
  }, [refreshProjects, replace]);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void initialize();
    }
  }, [initialize]);
  useEffect(() => {
    if (!project) return;
    localStorage.setItem('blai-project', project.id);
    let cancelled = false;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      const results = await Promise.allSettled([
        api.helper(),
        api.jobs(project.id),
        api.proposals(project.id),
      ]);
      if (!cancelled) {
        const [h, j, p] = results;
        if (h.status === 'fulfilled') setHelper(h.value);
        else setHelper(offlineHelper);
        if (j.status === 'fulfilled') {
          setJobs(j.value.jobs);
          for (const job of j.value.jobs) {
            const previousStatus = observedJobStates.current.get(job.id);
            observedJobStates.current.set(job.id, job.status);
            if (
              (previousStatus === 'queued' || previousStatus === 'running') &&
              job.status === 'completed'
            ) {
              notify(
                'Your proposal is ready. Choose Review proposal to see the suggested changes.',
              );
            }
            if (!reportedJobs.current.has(job.id) && job.status === 'failed') {
              reportedJobs.current.add(job.id);
              notify(jobFailureMessage(job));
            }
          }
        }
        if (p.status === 'fulfilled') setProposals(p.value.proposals);
      }
      polling = false;
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [project?.id, notify]);
  useEffect(() => {
    if (!modal) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setModal(null);
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.modal[role="dialog"]');
      if (!dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [modal, busy]);
  useEffect(() => {
    if (!modal) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('.modal[role="dialog"]');
      (
        dialog?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ||
        dialog?.querySelector<HTMLElement>('button:not(:disabled)') ||
        dialog
      )?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      previousFocus?.focus();
    };
  }, [modal]);
  useEffect(() => {
    const handleHistory = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        modal ||
        busy ||
        transitioning ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest('input, textarea, select') || target.isContentEditable)
      )
        return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z' || (key === 'y' && !event.shiftKey)) {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', handleHistory);
    return () => window.removeEventListener('keydown', handleHistory);
  }, [modal, busy, transitioning, undo, redo]);
  useEffect(() => {
    const navigateToRequirement = () => {
      if (!location.hash.startsWith('#requirement-')) return;
      const id = location.hash.slice(1);
      setView('handoff');
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        history.replaceState(null, '', location.pathname + location.search);
      }, 100);
    };
    window.addEventListener('hashchange', navigateToRequirement);
    navigateToRequirement();
    return () => window.removeEventListener('hashchange', navigateToRequirement);
  }, []);

  async function selectProject(id: string) {
    if (transitionLock.current) return;
    transitionLock.current = true;
    setTransitioning(true);
    try {
      await flush();
      const result = await api.get(id);
      replace(result.project);
      setJobs([]);
      setProposals([]);
      setView('plan');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
    }
  }
  const addAsset = useCallback(
    (projectId: string, asset: BoardAsset): boolean => {
      const latest = current.current;
      if (!latest || latest.id !== projectId || transitionLock.current) return false;
      if (latest.assets.some((item) => item.id === asset.id)) return true;
      change({ ...latest, assets: [...latest.assets, asset] });
      return true;
    },
    [change, current],
  );
  const addCanvasImage = useCallback(
    (
      asset: BoardAsset,
      projectId: string,
      screenId: string,
      node: WireNode,
      expectedEpoch: number,
    ): boolean => {
      const latest = current.current;
      if (
        !latest ||
        latest.id !== projectId ||
        transitionLock.current ||
        expectedEpoch !== editingEpochRef.current ||
        !latest.screens.some((screen) => screen.id === screenId && screen.canvas)
      )
        return false;
      const next: Project = {
        ...latest,
        assets: latest.assets.some((item) => item.id === asset.id)
          ? latest.assets
          : [...latest.assets, asset],
        screens: latest.screens.map((screen) =>
          screen.id === screenId ? { ...screen, nodes: [...screen.nodes, node] } : screen,
        ),
      };
      // Commit the asset and its layer together against the latest document.
      if (!projectSchema.safeParse(next).success) return false;
      change(next);
      return true;
    },
    [change, current],
  );
  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (transitionLock.current) return;
    transitionLock.current = true;
    setTransitioning(true);
    setBusy(true);
    try {
      await flush();
      const result = await api.create(projectName.trim() || 'Untitled product');
      replace(result.project);
      setJobs([]);
      setProposals([]);
      await refreshProjects();
      setProjectName('');
      setView('plan');
      setModal(null);
      notify('A fresh start. Your new project is ready.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
      setBusy(false);
    }
  }
  async function generate(kind: JobKind, instruction: string, screenId?: string) {
    if (!helper.online) {
      notify(
        'Connect your Codex helper to use AI. Your plans and designs can still be edited and saved.',
      );
      setView('settings');
      return false;
    }
    if (!current.current) return false;
    if (current.current.chat.length >= 199) {
      notify('This conversation is full. Start a new project to continue with Codex.');
      return false;
    }
    try {
      const active = current.current;
      change({
        ...active,
        chat: [
          ...active.chat,
          {
            id: uid('message'),
            role: 'user',
            text: instruction,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const saved = await flush();
      if (!saved) return false;
      const result = await api.generate(saved.id, kind, instruction, screenId);
      if (current.current?.id === saved.id) setJobs((previous) => [result.job, ...previous]);
      notify('Sent to Codex. You can keep exploring while it works.');
      return true;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    }
  }
  async function cancelJob(job: AIJob) {
    try {
      await api.cancel(job.projectId, job.id);
      const result = await api.jobs(job.projectId);
      if (current.current?.id !== job.projectId) return;
      setJobs(result.jobs);
    } catch (error) {
      notify(errorMessage(error));
    }
  }
  async function openVersions() {
    if (!project || transitionLock.current) return;
    try {
      const result = await api.versions(project.id);
      if (current.current?.id !== project.id || transitionLock.current) return;
      setVersions(result.versions);
      setModal('versions');
    } catch (error) {
      notify(errorMessage(error));
    }
  }
  async function checkpoint(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await flush();
      if (!saved) return;
      await api.checkpoint(saved.id, checkpointName.trim() || `Revision ${saved.revision}`);
      setCheckpointName('');
      const result = await api.versions(saved.id);
      setVersions(result.versions);
      notify('Checkpoint saved.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function restoreVersion(version: ProjectVersion) {
    if (
      !window.confirm(
        `Restore “${version.label}”? Save a checkpoint first if you want to keep your current version.`,
      )
    )
      return;
    if (transitionLock.current) return;
    transitionLock.current = true;
    setTransitioning(true);
    setBusy(true);
    try {
      const saved = await flush();
      if (!saved) return;
      const result = await api.restore(saved, version.id);
      replace(result.project, { record: true });
      await refreshProjects();
      setModal(null);
      notify('Project restored. You can undo this change.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
      setBusy(false);
    }
  }
  async function applyProposal(proposal: AIProposal) {
    if (transitionLock.current) return;
    transitionLock.current = true;
    setTransitioning(true);
    setBusy(true);
    try {
      const saved = await flush();
      if (!saved) return;
      const result = await api.apply(saved, proposal.id);
      replace(result.project, { record: true });
      setProposals((previous) =>
        previous.map((item) => (item.id === proposal.id ? { ...item, status: 'applied' } : item)),
      );
      notify('Changes applied to your project.');
      if (proposal.result.screens?.length) setView('wireframes');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const saved = await flush();
      if (!saved) return;
      const response = await fetch(`/api/projects/${saved.id}/export`);
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || 'Could not export this project.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${saved.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'product'}-spec.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      notify('Your specification package is ready.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function exportGithub(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setExportResult('');
    try {
      const saved = await flush();
      if (!saved) return;
      const result = await api.github(saved.id, { repository, branch, path: exportPath });
      setExportResult(result.url);
      notify('Specification committed to GitHub.');
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!project)
    return (
      <div className="boot-screen">
        <Brand />
        <div className="boot-card">
          {bootError ? (
            <>
              <h1>Let’s get connected.</h1>
              <p>{bootError}</p>
              <button className="btn primary" onClick={() => void initialize()}>
                Try again <ArrowRight size={16} />
              </button>
            </>
          ) : (
            <>
              <Loader2 className="spin" size={25} />
              <h1>Opening your studio…</h1>
              <p>A little space for your next big idea.</p>
            </>
          )}
        </div>
      </div>
    );
  const pending = proposals.filter((item) => item.status === 'pending');
  const activeJobs = jobs.filter((item) => item.status === 'queued' || item.status === 'running');
  const proposal = pending.find((item) => item.id === selectedProposal) || pending[0];
  const activeNav = navigation.find((item) => item.id === view);
  const completion = planCompletion(project.plan);

  return (
    <div className="studio-app">
      <aside className="sidebar" inert={Boolean(modal) || transitioning}>
        <Brand />
        <div className="workspace-label">
          PERSONAL WORKSPACE <span>01</span>
        </div>
        <label className="project-switch">
          <span className="project-avatar">{project.title.slice(0, 1).toUpperCase()}</span>
          <select
            aria-label="Current project"
            value={project.id}
            onChange={(event) => void selectProject(event.target.value)}
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id === project.id ? project.title : item.title}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <button className="new-project" onClick={() => setModal('new')}>
          <Plus size={15} /> New project
        </button>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav aria-label="Project sections">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === 'wireframes' && project.screens.length > 0 && (
                <small>{project.screens.length}</small>
              )}
              {item.id === 'review' &&
                project.assets.filter((asset) => asset.kind === 'screenshot').length > 0 && (
                  <small>
                    {project.assets.filter((asset) => asset.kind === 'screenshot').length}
                  </small>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-symbol">
            <Sparkles size={17} />
          </div>
          <strong>From thought to thing.</strong>
          <p>One connected place to shape what comes next.</p>
          <div className="tiny-route">
            <span />
            <i />
            <span />
            <i />
            <span />
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`helper-nav ${helper.online ? 'online' : ''}`}
            onClick={() => setView('settings')}
          >
            <span className="status-dot" />
            <span>
              <strong>{helper.online ? 'Codex connected' : 'Connect Codex'}</strong>
              <small>
                {helper.online ? 'Your Linux helper is ready' : 'Use your subscription'}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
          <div className="owner-row">
            <span className="owner-avatar">J</span>
            <div>
              <strong>Your workspace</strong>
              <small>{session?.local ? 'Local development' : 'Personal account'}</small>
            </div>
            <button
              aria-label="Workspace settings"
              className="icon-button"
              onClick={() => setView('settings')}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div
        className="studio-body"
        inert={Boolean(modal) || transitioning}
        aria-busy={transitioning}
      >
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={12} />
            <strong>{project.title}</strong>
            <span className="breadcrumb-divider">/</span>
            <span>{activeNav?.label || 'Connections'}</span>
          </div>
          <div className="topbar-actions">
            <div className="history-actions" role="group" aria-label="Edit history">
              <button
                className="icon-button"
                aria-label="Undo last edit"
                title="Undo (Ctrl/⌘ Z outside text fields)"
                disabled={!canUndo || busy}
                onClick={undo}
              >
                <Undo2 size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Redo last edit"
                title="Redo (Ctrl/⌘ Shift Z outside text fields)"
                disabled={!canRedo || busy}
                onClick={redo}
              >
                <Redo2 size={16} />
              </button>
            </div>
            <button
              className={`save-indicator ${saveState === 'error' ? 'error' : ''}`}
              onClick={() => void flush().catch((error) => notify(errorMessage(error)))}
              title={saveError || 'Save project'}
            >
              {saveState === 'saving' || saveState === 'pending' ? (
                <Loader2 size={13} className="spin" />
              ) : saveState === 'error' ? (
                <CircleHelp size={13} />
              ) : (
                <Cloud size={14} />
              )}
              <span>
                {saveState === 'saved'
                  ? 'All changes saved'
                  : saveState === 'error'
                    ? 'Save needs attention'
                    : 'Saving changes'}
              </span>
            </button>
            <button
              className="icon-button"
              aria-label="Project checkpoints"
              title="Project checkpoints"
              onClick={() => void openVersions()}
            >
              <History size={17} />
            </button>
            <button
              className={`btn small ${pending.length ? 'tinted' : 'subtle'}`}
              onClick={() => setModal('proposals')}
            >
              <Sparkles size={15} /> Proposals{' '}
              {pending.length > 0 && <span className="count-pill">{pending.length}</span>}
            </button>
          </div>
        </header>
        {saveError && (
          <div className="save-error" role="alert">
            {saveError} Your unsaved edits are still here.{' '}
            <button onClick={() => void flush().catch((error) => notify(errorMessage(error)))}>
              Retry save
            </button>
            <button
              onClick={() => {
                const data = new Blob([JSON.stringify(project, null, 2)], {
                  type: 'application/json',
                });
                const url = URL.createObjectURL(data);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'unsaved-project.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
              }}
            >
              Download unsaved copy
            </button>
            <button
              onClick={async () => {
                if (
                  !window.confirm(
                    'Reload the saved version? Unsaved edits in this tab will be discarded. Download your unsaved copy first if you want to keep them.',
                  )
                )
                  return;
                transitionLock.current = true;
                setTransitioning(true);
                try {
                  const result = await api.get(project.id);
                  replace(result.project);
                } catch (error) {
                  notify(errorMessage(error));
                } finally {
                  transitionLock.current = false;
                  setTransitioning(false);
                }
              }}
            >
              Reload saved version
            </button>
          </div>
        )}
        <AIActivity
          key={project.id}
          jobs={jobs}
          proposals={proposals}
          helper={helper}
          failureMessage={jobFailureMessage}
          onCancel={cancelJob}
          onReview={(proposalId) => {
            setSelectedProposal(proposalId);
            setModal('proposals');
          }}
        />
        <main className={`main-content view-${view}`}>
          {view === 'plan' && (
            <Planner
              key={project.id}
              project={project}
              onVisualize={() => {
                setVisualizeRequest((previous) => ({
                  projectId: project.id,
                  requestId: (previous?.requestId ?? 0) + 1,
                }));
                setView('flows');
              }}
              onChange={change}
              onGenerate={generate}
              prompt={chatDrafts[project.id] || ''}
              onPromptChange={(value) =>
                setChatDrafts((drafts) => ({ ...drafts, [project.id]: value }))
              }
              helper={helper}
              activeJobs={activeJobs}
              completion={completion}
              onCancel={(job) => void cancelJob(job)}
              onReview={() => setModal('proposals')}
              pending={pending.length}
            />
          )}
          {view === 'flows' && (
            <Suspense fallback={<p>Opening your overview…</p>}>
              <ProductOverview
                key={project.id}
                project={project}
                onNavigate={openOverviewSource}
                visualizeRequest={visualizeRequest}
              />
            </Suspense>
          )}
          {view === 'wireframes' && (
            <WireframeWorkspace
              key={project.id}
              project={project}
              onImageAdded={addCanvasImage}
              editingEpoch={editingEpoch}
              onChange={change}
              onToast={notify}
              onGenerate={generate}
              helperOnline={helper.online}
              focusTarget={
                activeSource?.source.kind === 'screen'
                  ? { ...activeSource.source, requestId: activeSource.requestId }
                  : undefined
              }
            />
          )}
          {view === 'moodboard' && (
            <BoardWorkspace
              key={project.id}
              project={project}
              onChange={change}
              onToast={notify}
              onGenerate={generate}
              helperOnline={helper.online}
              onAddAsset={addAsset}
              mode="reference"
              focusAsset={
                activeSource?.source.kind === 'asset'
                  ? { assetId: activeSource.source.assetId, requestId: activeSource.requestId }
                  : undefined
              }
            />
          )}
          {view === 'review' && (
            <BoardWorkspace
              key={project.id}
              project={project}
              onChange={change}
              onToast={notify}
              onGenerate={generate}
              helperOnline={helper.online}
              onAddAsset={addAsset}
              mode="screenshot"
              focusAsset={
                activeSource?.source.kind === 'asset'
                  ? { assetId: activeSource.source.assetId, requestId: activeSource.requestId }
                  : undefined
              }
            />
          )}
          {view === 'handoff' && (
            <Handoff
              key={project.id}
              project={project}
              onChange={change}
              completion={completion}
              onDownload={download}
              onGithub={() => {
                setExportResult('');
                setModal('github');
              }}
              busy={busy}
              onNavigate={setView}
              selectedCommentId={
                activeSource?.source.kind === 'comment' ? activeSource.source.commentId : undefined
              }
              onToast={notify}
            />
          )}
          {view === 'settings' && (
            <Connections helper={helper} session={session} onToast={notify} />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === 'proposals' ? 'proposal-modal' : ''}`}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-label={
              modal === 'new'
                ? 'Create a project'
                : modal === 'versions'
                  ? 'Project checkpoints'
                  : modal === 'github'
                    ? 'Export to GitHub'
                    : 'Review AI proposals'
            }
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
              disabled={busy}
            >
              <X size={19} />
            </button>
            {modal === 'new' && (
              <form onSubmit={createProject}>
                <div className="modal-icon">
                  <Plus size={23} />
                </div>
                <h2>What are we making?</h2>
                <p>Give your idea a name. There’s plenty of room to figure out the rest.</p>
                <label className="field-label">
                  Project name
                  <input
                    autoFocus
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="Your next good idea"
                    maxLength={120}
                    required
                  />
                </label>
                <button className="btn primary wide" disabled={busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <ArrowRight size={16} />} Create
                  project
                </button>
              </form>
            )}
            {modal === 'versions' && (
              <>
                <div className="modal-icon">
                  <History size={23} />
                </div>
                <h2>A point to come back to.</h2>
                <p>Save a named checkpoint before exploring a different direction.</p>
                <form className="checkpoint-form" onSubmit={checkpoint}>
                  <input
                    aria-label="Checkpoint name"
                    value={checkpointName}
                    onChange={(event) => setCheckpointName(event.target.value)}
                    placeholder="e.g. First direction approved"
                    maxLength={120}
                  />
                  <button className="btn primary" disabled={busy}>
                    Save
                  </button>
                </form>
                <div className="version-list">
                  {versions.length === 0 ? (
                    <div className="soft-empty">No checkpoints yet. Save your first one above.</div>
                  ) : (
                    versions.map((version) => (
                      <div className="version-row" key={version.id}>
                        <div>
                          <strong>{version.label}</strong>
                          <small>
                            Revision {version.revision} ·{' '}
                            {new Date(version.createdAt).toLocaleString()}
                          </small>
                        </div>
                        <button
                          className="btn subtle small"
                          disabled={busy}
                          onClick={() => void restoreVersion(version)}
                        >
                          Restore
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            {modal === 'github' && (
              <form onSubmit={exportGithub}>
                <div className="modal-icon">
                  <GitBranch size={23} />
                </div>
                <h2>A shared source of truth.</h2>
                <p>Commit the specification package to a folder in your chosen repository.</p>
                {!session?.githubConfigured && (
                  <div className="info-box">
                    GitHub export needs a server-side <code>GITHUB_TOKEN</code> with write access to
                    the destination repository. Configure it in your Cloudflare Worker secrets; the
                    download works now.
                  </div>
                )}
                <label className="field-label">
                  Repository
                  <input
                    value={repository}
                    onChange={(event) => setRepository(event.target.value)}
                    placeholder="owner/repository"
                    required
                    pattern="[^/\s]+/[^/\s]+"
                  />
                </label>
                <div className="field-pair">
                  <label className="field-label">
                    Branch
                    <input
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      required
                    />
                  </label>
                  <label className="field-label">
                    Destination folder
                    <input
                      value={exportPath}
                      onChange={(event) => setExportPath(event.target.value)}
                      required
                    />
                  </label>
                </div>
                <p className="fine-print">
                  Files in the specification folder will be updated. Other repository files are
                  preserved.
                </p>
                {exportResult && (
                  <a className="success-link" href={exportResult} target="_blank" rel="noreferrer">
                    View committed specification <ArrowUpRight size={14} />
                  </a>
                )}
                <button className="btn primary wide" disabled={busy || !session?.githubConfigured}>
                  {busy ? <Loader2 size={16} className="spin" /> : <GitBranch size={16} />} Commit
                  specification
                </button>
              </form>
            )}
            {modal === 'proposals' && (
              <>
                <div className="modal-icon">
                  <Sparkles size={23} />
                </div>
                <h2>A second pair of eyes.</h2>
                <p>Review what Codex suggests. Your work changes only when you accept.</p>
                {pending.length === 0 ? (
                  <div className="proposal-empty">
                    <Sparkles size={35} />
                    <h3>No proposals waiting.</h3>
                    <p>
                      Ask Codex to improve your plan or generate wireframes. Its suggestions will
                      appear here.
                    </p>
                    {activeJobs.length > 0 && (
                      <span className="working-label">
                        <Loader2 size={14} className="spin" /> Codex is working…
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="proposal-layout">
                    <div className="proposal-list">
                      {pending.map((item) => (
                        <button
                          key={item.id}
                          className={proposal?.id === item.id ? 'selected' : ''}
                          onClick={() => setSelectedProposal(item.id)}
                        >
                          <span>{item.result.title}</span>
                          <small>{item.kind.replaceAll('.', ' · ')}</small>
                        </button>
                      ))}
                    </div>
                    {proposal && (
                      <div className="proposal-detail">
                        <span className="eyebrow">
                          PROPOSED CHANGES · REVISION {proposal.baseRevision}
                        </span>
                        <h3>{proposal.result.title}</h3>
                        <p>{proposal.result.summary}</p>
                        {proposal.result.reply && (
                          <div className="proposal-reply">{proposal.result.reply}</div>
                        )}
                        <ProposalChanges project={project} proposal={proposal} />
                        {proposal.baseRevision !== project.revision && (
                          <div className="info-box warning">
                            Your project changed after this proposal was requested. Dismiss it and
                            ask Codex for a fresh proposal to preserve your newer edits.
                          </div>
                        )}
                        <div className="proposal-actions">
                          <button
                            className="btn subtle"
                            disabled={busy}
                            onClick={async () => {
                              try {
                                await api.dismiss(project.id, proposal.id);
                                setProposals((items) =>
                                  items.filter((item) => item.id !== proposal.id),
                                );
                              } catch (error) {
                                notify(errorMessage(error));
                              }
                            }}
                          >
                            Dismiss
                          </button>
                          <button
                            className="btn primary"
                            disabled={
                              busy ||
                              saveState !== 'saved' ||
                              proposal.baseRevision !== project.revision
                            }
                            onClick={() => void applyProposal(proposal)}
                          >
                            <CheckCheck size={16} /> Apply changes
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        blai<span className="brand-period">.</span>
      </span>
      <small>PRODUCT DESIGNER</small>
    </div>
  );
}

function Planner({
  project,
  onChange,
  onGenerate,
  helper,
  activeJobs,
  completion,
  onCancel,
  onReview,
  pending,
  prompt,
  onPromptChange,
  onVisualize,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onGenerate: (kind: JobKind, instruction: string) => Promise<boolean>;
  prompt: string;
  onPromptChange: (value: string) => void;
  helper: HelperStatus;
  activeJobs: AIJob[];
  completion: number;
  onCancel: (job: AIJob) => void;
  onReview: () => void;
  pending: number;
  onVisualize: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);
  useEffect(() => setDraftTitle(project.title), [project.title]);
  const latestPrompt = useRef(prompt);
  latestPrompt.current = prompt;
  const suggestions = [
    'Find the gaps in my plan',
    'Sharpen the user journeys',
    'Make the scope buildable',
  ];
  return (
    <div className="planner-workspace">
      <div className="planner-main">
        <div className="page-heading">
          <div>
            <span className="eyebrow">
              <span className="section-number">01</span> SET THE DIRECTION
            </span>
            <h1>
              Every good thing
              <br />
              <span>starts with a clear idea.</span>
            </h1>
            <p>
              Put your thinking into words. Shape it with Codex. Build from a shared understanding.
            </p>
            <button className="btn outlined small overview-plan-button" onClick={onVisualize}>
              <GitBranch size={14} /> Visualize product
            </button>
          </div>
          <div
            className="readiness-ring"
            style={{ '--progress': `${completion * 3.6}deg` } as React.CSSProperties}
          >
            <span>
              <strong>
                {completion}
                <small>%</small>
              </strong>
              <small>plan coverage</small>
            </span>
          </div>
        </div>
        <div className="plan-metrics">
          <span>
            <i className="purple-dot" />{' '}
            {PLAN_FIELDS.filter(([key]) => project.plan[key].trim().length > 15).length} sections
            started
          </span>
          <span>
            <Layers3 size={14} /> {project.screens.length} screens connected
          </span>
          <span>
            <CheckCheck size={14} />{' '}
            {project.requirements.filter((item) => item.status === 'accepted').length} accepted
            requirements
          </span>
        </div>
        <article className="plan-document" id="product-plan-document">
          <div className="document-topline">
            <span>
              <FileText size={14} /> PRODUCT SPECIFICATION
            </span>
            <span className="document-revision">
              v{project.revision.toString().padStart(2, '0')}
            </span>
          </div>
          <input
            className="document-title"
            aria-label="Project title"
            value={draftTitle}
            maxLength={120}
            onChange={(event) => {
              setDraftTitle(event.target.value);
              if (event.target.value.trim()) onChange({ ...project, title: event.target.value });
            }}
            onBlur={() => setDraftTitle(project.title)}
          />
          <textarea
            className="document-summary"
            aria-label="Project summary"
            placeholder="The idea, in a sentence or two."
            value={project.summary}
            rows={2}
            maxLength={4000}
            onChange={(event) => onChange({ ...project, summary: event.target.value })}
          />
          <div className="document-meta">
            <span className="meta-tag">
              <span className="status-dot" /> Living document
            </span>
            <label>
              <Monitor size={13} />
              <select
                aria-label="Product platform"
                value={project.platform}
                onChange={(event) =>
                  onChange({ ...project, platform: event.target.value as Project['platform'] })
                }
              >
                <option value="both">Web + mobile apps</option>
                <option value="web">Responsive web</option>
                <option value="mobile">Mobile apps</option>
              </select>
              <ChevronDown size={11} />
            </label>
          </div>
          {PLAN_FIELDS.map(([key, label, placeholder], index) => (
            <section className="plan-section" key={key} id={`plan-${key}`}>
              <div className="plan-section-heading">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h2>{label}</h2>
                <button
                  className="icon-button"
                  title={`Ask Codex to improve ${label.toLowerCase()}`}
                  aria-label={`Improve ${label}`}
                  onClick={() =>
                    onGenerate(
                      'plan.assist',
                      `Improve the ${label.toLowerCase()} section. Explain any assumptions and propose clear implementation requirements.`,
                    )
                  }
                >
                  <Sparkles size={15} />
                </button>
              </div>
              <textarea
                aria-label={label}
                maxLength={24000}
                value={project.plan[key]}
                placeholder={placeholder}
                rows={Math.min(8, Math.max(3, Math.ceil(project.plan[key].length / 105)))}
                onChange={(event) =>
                  onChange({ ...project, plan: { ...project.plan, [key]: event.target.value } })
                }
              />
            </section>
          ))}
          <div className="document-footer">
            <span>A shared understanding is the best starting point.</span>
            <button
              className="btn subtle small"
              onClick={() =>
                onGenerate(
                  'plan.review',
                  'Review this product specification for missing decisions, contradictory requirements, untestable acceptance criteria, and first-version scope. Propose concrete improvements.',
                )
              }
            >
              <Sparkles size={14} /> Review for gaps
            </button>
          </div>
        </article>
      </div>
      <aside className="thinking-panel">
        <div className="thinking-heading">
          <span className="sparkle-square">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>A thinking partner</strong>
            <small>Powered by your Codex</small>
          </div>
          <span
            className={`connection-indicator ${helper.online ? 'connected' : ''}`}
            title={helper.online ? 'Helper online' : 'Helper not connected'}
          />
        </div>
        <div className="thinking-context">
          <Layers3 size={13} />
          <span>Connected to your whole project</span>
          <ShieldCheck size={13} />
        </div>
        <div className="chat-history">
          {project.chat.length === 0 ? (
            <div className="chat-welcome">
              <div className="welcome-orbit">
                <Sparkles size={24} />
              </div>
              <h3>
                Let’s make it
                <br />a little clearer.
              </h3>
              <p>
                Explore an idea, untangle a question, or turn a rough thought into a useful
                requirement.
              </p>
              <div className="chat-suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} onClick={() => onPromptChange(suggestion)}>
                    {suggestion}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
              <div className="review-note">
                <CheckCheck size={14} />
                <span>You review every change before it’s applied.</span>
              </div>
            </div>
          ) : (
            project.chat.map((message) => (
              <div
                key={message.id}
                id={`chat-${message.id}`}
                className={`chat-message ${message.role}`}
              >
                <strong>{message.role === 'user' ? 'You' : 'Codex'}</strong>
                <p>{message.text}</p>
              </div>
            ))
          )}
          {activeJobs.map((job) => (
            <div key={job.id} className="job-card">
              <Loader2 className="spin" size={15} />
              <div>
                <strong>{jobStageLabel(job)}</strong>
                <small>{job.kind.replaceAll('.', ' · ')}</small>
              </div>
              <button aria-label="Cancel AI request" onClick={() => onCancel(job)}>
                <X size={14} />
              </button>
            </div>
          ))}
          {pending > 0 && (
            <button className="review-proposal-card" onClick={onReview}>
              <Sparkles size={17} />
              <span>
                {pending} proposal{pending > 1 ? 's' : ''} ready to review
              </span>
              <ArrowRight size={15} />
            </button>
          )}
        </div>
        <form
          className="chat-composer"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!prompt.trim() || submitting) return;
            const sent = prompt;
            setSubmitting(true);
            try {
              if (await onGenerate('plan.assist', sent.trim())) {
                if (latestPrompt.current === sent) onPromptChange('');
              }
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            aria-label="Message Codex"
            placeholder="A thought, a question, a what if…"
            rows={3}
            maxLength={12000}
          />
          <div>
            <span>
              <span className={`status-dot ${helper.online ? 'connected' : ''}`} />
              {helper.online ? 'Codex is ready' : 'Connect helper to begin'}
            </span>
            <button aria-label="Send to Codex" disabled={!prompt.trim() || submitting}>
              <ArrowRight size={17} />
            </button>
          </div>
        </form>
        <p className="composer-footnote">Your idea stays yours. AI helps it take shape.</p>
      </aside>
    </div>
  );
}

function Handoff({
  project,
  onChange,
  completion,
  onDownload,
  onGithub,
  busy,
  onNavigate,
  onToast,
  selectedCommentId,
}: {
  project: Project;
  onChange: (p: Project) => void;
  completion: number;
  onDownload: () => void;
  onGithub: () => void;
  busy: boolean;
  onNavigate: (v: View) => void;
  onToast: (message: string) => void;
  selectedCommentId?: string;
}) {
  const toggleRequirement = (id: string) => {
    const requirement = project.requirements.find((item) => item.id === id);
    if (!requirement) return;
    const accepted = requirement.status !== 'accepted';
    onChange({
      ...project,
      requirements: project.requirements.map((item) =>
        item.id === id ? { ...item, status: accepted ? 'accepted' : 'proposed' } : item,
      ),
      comments: project.comments.map((comment) =>
        comment.id === requirement.sourceCommentId
          ? { ...comment, status: accepted ? 'accepted' : 'open', requirementId: id }
          : comment,
      ),
    });
  };
  const open = project.comments.filter((comment) => comment.status === 'open');
  const checks = [
    {
      title: 'Product plan',
      detail: `${completion}% of core sections have content`,
      ready: completion === 100,
      view: 'plan' as View,
    },
    {
      title: 'Editable screens',
      detail: `${project.screens.length} screen${project.screens.length === 1 ? '' : 's'} with structured components`,
      ready: project.screens.length > 0,
      view: 'wireframes' as View,
    },
    {
      title: 'Visual direction',
      detail: `${project.assets.filter((asset) => asset.kind === 'reference').length} references and shared design tokens`,
      ready: project.assets.some((asset) => asset.kind === 'reference'),
      view: 'moodboard' as View,
    },
    {
      title: 'Decisions & requirements',
      detail: `${project.requirements.filter((item) => item.status === 'accepted').length} accepted · ${open.length} comments still open`,
      ready: project.requirements.some((item) => item.status === 'accepted') && open.length === 0,
      view: 'review' as View,
    },
  ];
  return (
    <div className="handoff-workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <span className="section-number">05</span> CONNECT THE DOTS
          </span>
          <h1>
            Ready to make
            <br />
            <span>something real.</span>
          </h1>
          <p>
            Your thinking, your designs, and your decisions. One clear starting point for Codex.
          </p>
        </div>
        <div className="handoff-graphic">
          <FileText size={27} />
          <i />
          <Code2 size={28} />
        </div>
      </div>
      <div className="handoff-grid">
        <div>
          <div className="section-label">
            THE SHARED UNDERSTANDING <span>Revision {project.revision}</span>
          </div>
          <div className="readiness-checks">
            {checks.map((check) => (
              <button key={check.title} onClick={() => onNavigate(check.view)}>
                <span className={`check-circle ${check.ready ? 'complete' : ''}`}>
                  {check.ready ? <Check size={15} /> : <MoreHorizontal size={16} />}
                </span>
                <span>
                  <strong>{check.title}</strong>
                  <small>{check.detail}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          {project.plan.questions.trim() && (
            <div className="open-questions">
              <span className="eyebrow">WORTH RESOLVING</span>
              <h3>A few open questions.</h3>
              <p>{project.plan.questions}</p>
              <button className="text-button" onClick={() => onNavigate('plan')}>
                Back to the plan <ArrowRight size={14} />
              </button>
            </div>
          )}
          <section className="requirements-section">
            <div className="section-label">
              ACCEPTANCE & REQUIREMENTS <span>{project.requirements.length}</span>
            </div>
            {project.requirements.length === 0 ? (
              <div className="soft-empty">
                Accept an annotation as a requirement to make decisions explicit.
              </div>
            ) : (
              project.requirements.map((requirement) => (
                <div
                  className="requirement-card"
                  id={`requirement-${requirement.id}`}
                  key={requirement.id}
                >
                  <button
                    aria-label={
                      requirement.status === 'accepted'
                        ? 'Mark requirement proposed'
                        : 'Accept requirement'
                    }
                    className={`check-circle ${requirement.status === 'accepted' ? 'complete' : ''}`}
                    onClick={() => toggleRequirement(requirement.id)}
                  >
                    {requirement.status === 'accepted' ? <Check size={14} /> : null}
                  </button>
                  <div>
                    <p>{requirement.text}</p>
                    <small>
                      {requirement.status === 'accepted'
                        ? 'Accepted requirement'
                        : 'Proposed requirement'}
                      {requirement.sourceCommentId ? ' · From an annotation' : ''}
                    </small>
                  </div>
                </div>
              ))
            )}
          </section>
          {
            <section className="handoff-annotations">
              <div className="section-label">PROJECT DISCUSSION</div>
              <AnnotationPanel
                project={project}
                onChange={onChange}
                onToast={onToast}
                selectedId={selectedCommentId}
              />
            </section>
          }
        </div>
        <aside className="export-card">
          <div className="export-card-top">
            <span className="export-symbol">
              <Code2 size={27} />
            </span>
            <span className="pill">CODEX READY FORMAT</span>
          </div>
          <h2>
            The whole picture,
            <br />
            in one package.
          </h2>
          <p>A portable specification that keeps the intent behind every screen.</p>
          <ul>
            <li>
              <FileText size={16} />
              <span>
                Product specification
                <small>Readable Markdown, goals, and acceptance criteria</small>
              </span>
            </li>
            <li>
              <Layers3 size={16} />
              <span>
                Screens & structure<small>Visual exports plus editable component definitions</small>
              </span>
            </li>
            <li>
              <GitBranch size={16} />
              <span>
                Automatic product overview
                <small>Product map, written journey, and defined screen links</small>
              </span>
            </li>
            <li>
              <Image size={16} />
              <span>
                References & assets
                <small>Images, sources, and the direction they communicate</small>
              </span>
            </li>
            <li>
              <MessageSquare size={16} />
              <span>
                Decisions & open questions
                <small>Accepted requirements kept distinct from discussion</small>
              </span>
            </li>
          </ul>
          <button className="btn primary wide" disabled={busy} onClick={onDownload}>
            {busy ? <Loader2 className="spin" size={16} /> : <ArrowDownToLine size={16} />} Download
            specification
          </button>
          <button className="btn outlined wide" disabled={busy} onClick={onGithub}>
            <GitBranch size={16} /> Save to GitHub
          </button>
          <p className="fine-print">
            Exports reflect the current saved revision. Open questions remain visible for Codex to
            resolve.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Connections({
  helper,
  session,
  onToast,
}: {
  helper: HelperStatus;
  session: { email: string; local: boolean; githubConfigured: boolean } | null;
  onToast: (message: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  async function settingsDownload() {
    setDownloading(true);
    try {
      const response = await fetch('/api/helper/setup');
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || 'Helper settings are not configured yet.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'blai-designer-helper.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      onToast(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  }
  return (
    <div className="connections-workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR TOOLS, CONNECTED</span>
          <h1>
            A familiar mind.
            <br />
            <span>A new place to create.</span>
          </h1>
          <p>Use one BLAI Helper for Designer, Writer, and future tools on your Linux computer.</p>
        </div>
      </div>
      <div className="connection-card">
        <div className="connection-card-heading">
          <span className="export-symbol">
            <Code2 size={25} />
          </span>
          <div>
            <h2>BLAI Helper</h2>
            <p>
              One manager. Your existing ChatGPT sign-in.
              {helper.helperVersion ? ` Connected version: ${helper.helperVersion}.` : ''}
            </p>
          </div>
          <span className={`pill ${helper.online ? 'green' : ''}`}>
            <span className="status-dot" />
            {helper.online ? 'Connected' : 'Not connected'}
          </span>
        </div>
        <div className="connection-flow">
          <span>
            <Monitor size={23} /> This studio
          </span>
          <i />
          <span>
            <Cloud size={23} /> Cloudflare queue
          </span>
          <i />
          <span>
            <Code2 size={23} /> Your Linux helper
          </span>
        </div>
        <div className="setup-steps">
          <div>
            <span>1</span>
            <section>
              <h3>Download the manager and Designer settings</h3>
              <p>
                Save downloads to Downloads on your Linux computer. To update an existing manager,
                download BLAI Helper only. Designer settings are needed when adding Designer for the
                first time and contain private connection credentials.
              </p>
              <p>
                Version 1.1.0 supports freeform canvas designs with GPT-6 Astra at Medium reasoning
                through your ChatGPT Codex subscription, with an 872,000-token model context—the
                current published maximum in Codex. Project input limits still apply. Install this
                update on the Linux computer running your helper to use these settings.
              </p>
              <a
                className="btn outlined"
                href="/blai-helper.tar.gz"
                download="blai-helper-1.1.0.tar.gz"
              >
                <ArrowDownToLine size={15} /> Download BLAI Helper 1.1.0
              </a>{' '}
              <button
                className="btn outlined"
                onClick={() => void settingsDownload()}
                disabled={downloading}
              >
                <ArrowDownToLine size={15} />
                {downloading ? 'Preparing…' : 'Download Designer settings'}
              </button>
            </section>
          </div>
          <div>
            <span>2</span>
            <section>
              <h3>Connect Designer</h3>
              <p>
                Requires Node.js 22.13 or newer, a Linux systemd user session, and an up-to-date
                Codex CLI signed in with ChatGPT. Stop any old helper running in a terminal with
                Ctrl+C before installing.
              </p>
              <details>
                <summary>Update BLAI Helper to 1.1.0</summary>
                <p>
                  Download BLAI Helper 1.1.0 above, then run these commands in order on the Linux
                  computer running your helper. Stop if a command reports an error. Your existing
                  profiles and ChatGPT sign-in are reused; no settings download is needed.
                </p>
                <pre>
                  <code>{`blai_helper_dir="$(mktemp -d "$HOME/blai-helper.XXXXXX")"
tar -xzf "$HOME/Downloads/blai-helper-1.1.0.tar.gz" -C "$blai_helper_dir"
cd "$blai_helper_dir/blai-helper"
npm ci --omit=dev
node bin/blai-helper.mjs doctor
node bin/blai-helper.mjs install
"$HOME/.local/bin/blai-helper" --version
"$HOME/.local/bin/blai-helper" status`}</code>
                </pre>
                <p>
                  The version command should print <code>BLAI Helper 1.1.0</code>. Installation
                  restarts the service for all configured tools. Keep the new extracted directory
                  and its dependencies in place; the service runs from there. Keep the old directory
                  until the new helper connects.
                </p>
              </details>
              <details>
                <summary>First time installing BLAI Helper</summary>
                <p>
                  Open a terminal on this Linux computer and run these commands in order. Stop if a
                  command reports an error.
                </p>
                <pre>
                  <code>{`blai_helper_dir="$(mktemp -d "$HOME/blai-helper.XXXXXX")"
tar -xzf "$HOME/Downloads/blai-helper-1.1.0.tar.gz" -C "$blai_helper_dir"
cd "$blai_helper_dir/blai-helper"
npm ci --omit=dev
node bin/blai-helper.mjs add designer --adapter designer --settings "$HOME/Downloads/blai-designer-helper.json"
node bin/blai-helper.mjs doctor
node bin/blai-helper.mjs install --migrate`}</code>
                </pre>
              </details>
              <details>
                <summary>Add Designer to an installed manager</summary>
                <p>
                  Add Designer to the same manager. Installation restarts the service; your other
                  configured tools reconnect afterward.
                </p>
                <pre>
                  <code>{`"$HOME/.local/bin/blai-helper" add designer --adapter designer --settings "$HOME/Downloads/blai-designer-helper.json"
"$HOME/.local/bin/blai-helper" doctor
"$HOME/.local/bin/blai-helper" install --migrate`}</code>
                </pre>
              </details>
              <p>
                To combine an older Writer helper too, import its settings before migration using
                the full instructions below. Keep the extracted helper directory in place after
                installation. Each tool keeps its own private connection settings.
              </p>
              <a
                className="text-button"
                href="https://github.com/JoDavidsson/BLAI-Product-Designer/blob/main/docs/CODEX-HELPER.md"
                target="_blank"
                rel="noreferrer"
              >
                Full setup and migration instructions <ArrowUpRight size={14} />
              </a>
            </section>
          </div>
          <div>
            <span>3</span>
            <section>
              <h3>Check the connection</h3>
              <pre>
                <code>{`"$HOME/.local/bin/blai-helper" status`}</code>
              </pre>
              <p>
                Designer should show connected here and in the terminal. Try a request in the Design
                assistant to confirm Codex can answer. Once installation succeeds, you can close the
                terminal; the manager starts at Linux sign-in.
              </p>
            </section>
          </div>
        </div>
        <div className="connection-footer">
          <ShieldCheck size={16} />
          <p>
            The helper checks for work using outbound connections. Your Codex login stays on Linux.
            Your computer needs to be awake for AI requests.
          </p>
        </div>
      </div>
      <div className="settings-pair">
        <div className="settings-card">
          <GitBranch size={21} />
          <h3>GitHub handoff</h3>
          <p>
            {session?.githubConfigured
              ? 'A GitHub credential is configured. Choose the destination repository when exporting.'
              : 'Add GITHUB_TOKEN as a Worker secret to enable committing specifications. Downloadable packages work independently.'}
          </p>
          <span className={`pill ${session?.githubConfigured ? 'green' : ''}`}>
            {session?.githubConfigured ? 'Configured' : 'Setup needed'}
          </span>
        </div>
        <div className="settings-card">
          <ShieldCheck size={21} />
          <h3>Your personal workspace</h3>
          <p>
            {session?.local
              ? 'This instance uses local development authentication. Production requires Cloudflare Access and your allowed email.'
              : `Protected by Cloudflare Access. Signed in as ${session?.email || 'the workspace owner'}.`}
          </p>
          <span className="pill">{session?.local ? 'Local development' : 'Private access'}</span>
        </div>
      </div>
    </div>
  );
}
