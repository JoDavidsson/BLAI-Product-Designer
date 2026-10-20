import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import type { AIJob, AIProposal, AIUsage, HelperStatus } from '../../shared/model';
import './AIActivity.css';

const kindLabels: Record<AIJob['kind'], string> = {
  'plan.assist': 'Plan assistance',
  'plan.review': 'Plan review',
  'wireframe.generate': 'Wireframe generation',
  'wireframe.refine': 'Wireframe refinement',
  'moodboard.direction': 'Design direction',
};
const progressLabels: Record<NonNullable<AIJob['progressStage']>, string> = {
  launching: 'Starting Codex',
  'model-started': 'Codex started',
  'response-received': 'Response received',
  validating: 'Checking result',
};

export function jobStageLabel(job: AIJob, proposal?: AIProposal) {
  if (job.status === 'queued') return 'Waiting for helper';
  if (job.status === 'failed') return 'Request failed';
  if (job.status === 'cancelled') return 'Request cancelled';
  if (job.status === 'completed') {
    if (proposal?.status === 'pending') return 'Ready to review';
    if (proposal?.status === 'applied') return 'Applied to project';
    if (proposal?.status === 'dismissed') return 'Proposal dismissed';
    return 'Request completed';
  }
  return job.progressStage ? progressLabels[job.progressStage] : 'Helper accepted request';
}

function timestamp(value?: string | null) {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
}

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function requestDuration(job: AIJob, now: number) {
  const start = timestamp(job.startedAt) ?? timestamp(job.createdAt);
  const end =
    job.status === 'queued' || job.status === 'running' ? now : timestamp(job.completedAt);
  return start !== undefined && end !== undefined ? duration(end - start) : undefined;
}

const usageFields: { key: keyof AIUsage; label: string }[] = [
  { key: 'inputTokens', label: 'Input' },
  { key: 'outputTokens', label: 'Output' },
  { key: 'cachedInputTokens', label: 'Cached input' },
  { key: 'cacheWriteInputTokens', label: 'Cache write input' },
  { key: 'reasoningOutputTokens', label: 'Reasoning output' },
];

function TokenUsage({ job }: { job: AIJob }) {
  const hasUsage = usageFields.some(
    ({ key }) => Number.isSafeInteger(job.usage?.[key]) && Number(job.usage?.[key]) >= 0,
  );
  const active = job.status === 'queued' || job.status === 'running';
  return (
    <div className="ai-activity-usage">
      <h4>Token usage</h4>
      {hasUsage ? (
        <dl>
          {usageFields.map(({ key, label }) => {
            const value = job.usage?.[key];
            return (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {Number.isSafeInteger(value) && Number(value) >= 0
                    ? value!.toLocaleString()
                    : 'Not reported'}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p>
          {active
            ? 'Token usage has not been reported yet.'
            : 'Token usage was not reported for this request.'}
          {!active &&
            !job.helperVersion &&
            ' Update to Helper 1.0.2 for available usage on new requests.'}
        </p>
      )}
    </div>
  );
}

function StatusIcon({ job }: { job?: AIJob }) {
  if (job?.status === 'queued' || job?.status === 'running')
    return <Loader2 size={16} className="spin" />;
  if (job?.status === 'failed') return <CircleAlert size={16} />;
  if (job?.status === 'cancelled') return <X size={16} />;
  return <Check size={16} />;
}

export default function AIActivity({
  jobs,
  proposals,
  helper,
  onReview,
  onCancel,
  failureMessage,
}: {
  jobs: AIJob[];
  proposals: AIProposal[];
  helper: HelperStatus;
  onReview: (proposalId: string) => void;
  onCancel: (job: AIJob) => Promise<void>;
  failureMessage: (job: AIJob) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState('');
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const ordered = [...jobs].sort(
    (a, b) => (timestamp(b.createdAt) ?? 0) - (timestamp(a.createdAt) ?? 0),
  );
  const highlighted =
    active.find((job) => job.status === 'running') ||
    active[0] ||
    ordered.find((job) => pending.some((proposal) => proposal.jobId === job.id)) ||
    ordered[0];
  const highlightedProposal = proposals.find((proposal) => proposal.jobId === highlighted?.id);
  const reviewProposal =
    highlightedProposal?.status === 'pending' ? highlightedProposal : pending[0];
  const elapsed = highlighted && requestDuration(highlighted, now);
  const recent = [
    ...active,
    ...ordered.filter((job) => job.status !== 'queued' && job.status !== 'running').slice(0, 6),
  ];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);

  if (!highlighted && !reviewProposal) return null;
  const review = (id: string) => {
    setExpanded(false);
    onReview(id);
  };
  return (
    <section
      className={`ai-activity ${pending.length ? 'has-proposal' : ''}`}
      aria-label="AI request activity"
    >
      <div className="ai-activity-bar">
        <button
          className="ai-activity-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="ai-activity-details"
          aria-label={`${expanded ? 'Hide' : 'Show'} AI request activity`}
        >
          <span className={`ai-activity-icon ${highlighted?.status || 'completed'}`}>
            <StatusIcon job={highlighted} />
          </span>
          <span className="ai-activity-summary">
            <strong>{highlighted ? kindLabels[highlighted.kind] : 'AI proposal'}</strong>
            <span aria-live="polite">
              {highlighted ? jobStageLabel(highlighted, highlightedProposal) : 'Ready to review'}
              {active.length > 1 ? ` · ${active.length} active requests` : ''}
            </span>
          </span>
          {elapsed && (
            <span className="ai-activity-elapsed">
              <Clock3 size={12} />
              {elapsed}
            </span>
          )}
          <ChevronDown size={15} className={expanded ? 'is-expanded' : ''} />
        </button>
        {reviewProposal && (
          <button className="ai-activity-review" onClick={() => review(reviewProposal.id)}>
            <Sparkles size={14} /> Review proposal
            {pending.length > 1 ? `s (${pending.length})` : ''}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="ai-activity-details" id="ai-activity-details">
          <div className="ai-activity-heading">
            <div>
              <h2>AI requests</h2>
              <p>
                {helper.online ? 'Helper connected' : 'Helper offline'}
                {helper.helperVersion ? ` · v${helper.helperVersion}` : ''}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="Close AI request activity"
              onClick={() => setExpanded(false)}
            >
              <X size={16} />
            </button>
          </div>
          {recent.map((job) => {
            const proposal = proposals.find((item) => item.jobId === job.id);
            const isActive = job.status === 'queued' || job.status === 'running';
            const heartbeat = timestamp(job.lastHeartbeatAt);
            const elapsed = requestDuration(job, now);
            return (
              <article
                className={`ai-request ${job.status}`}
                key={job.id}
                aria-label={`${kindLabels[job.kind]} request`}
              >
                <div className="ai-request-heading">
                  <StatusIcon job={job} />
                  <strong>{kindLabels[job.kind]}</strong>
                  <span>{jobStageLabel(job, proposal)}</span>
                </div>
                <p className="ai-request-instruction">{job.instruction}</p>
                <div className="ai-request-timing">
                  {elapsed && (
                    <span>
                      {isActive ? 'Elapsed' : 'Duration'} {elapsed}
                    </span>
                  )}
                  {job.helperVersion && <span>Helper v{job.helperVersion}</span>}
                  {(job.status === 'failed' || job.status === 'cancelled') && job.progressStage && (
                    <span>Last reported stage: {progressLabels[job.progressStage]}</span>
                  )}
                  {job.status === 'running' && (
                    <span>
                      {heartbeat !== undefined
                        ? `Helper check-in ${duration(now - heartbeat)} ago`
                        : 'Waiting for first helper check-in'}
                    </span>
                  )}
                  {!isActive && (
                    <time dateTime={job.completedAt || job.createdAt}>
                      {job.completedAt ? 'Finished ' : 'Requested '}
                      {new Date(job.completedAt || job.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  )}
                </div>
                {job.status === 'running' &&
                  heartbeat !== undefined &&
                  now - heartbeat > 20_000 && (
                    <p className="ai-request-notice">
                      The helper has not checked in recently. Its connection may have been
                      interrupted.
                    </p>
                  )}
                {job.status === 'running' && !job.progressStage && (
                  <p className="ai-request-note">
                    The helper accepted this request. Detailed progress has not been reported.
                  </p>
                )}
                {job.status === 'failed' && (
                  <p className="ai-request-notice">{failureMessage(job)}</p>
                )}
                <TokenUsage job={job} />
                <div className="ai-request-actions">
                  {isActive && (
                    <button
                      className="btn subtle small"
                      disabled={cancelling === job.id}
                      onClick={async () => {
                        setCancelling(job.id);
                        try {
                          await onCancel(job);
                        } finally {
                          setCancelling('');
                        }
                      }}
                    >
                      {cancelling === job.id ? 'Cancelling…' : 'Cancel request'}
                    </button>
                  )}
                  {proposal?.status === 'pending' && (
                    <button className="btn primary small" onClick={() => review(proposal.id)}>
                      Review proposal <ArrowRight size={14} />
                    </button>
                  )}
                  {job.status === 'completed' && proposal?.status === 'pending' && (
                    <span>Your project changes when you accept.</span>
                  )}
                </div>
              </article>
            );
          })}
          <p className="ai-activity-footnote">
            Progress reflects helper updates. Token counts appear when Codex reports them.
          </p>
        </div>
      )}
    </section>
  );
}
