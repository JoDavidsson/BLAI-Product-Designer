import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  CornerDownRight,
  MessageCircle,
  Plus,
  Send,
  X,
  RotateCcw,
  ArrowUpRight,
} from 'lucide-react';
import { uid, type Annotation, type AnnotationTarget, type Project } from '../../shared/model';
import './annotations.css';

interface Props {
  project: Project;
  onChange: (project: Project) => void;
  target?: AnnotationTarget;
  onClose?: () => void;
  onToast: (message: string) => void;
  filter?: { screenId?: string; assetId?: string };
  selectedId?: string;
}

function targetLabel(target: AnnotationTarget, project: Project): string {
  if (target.assetId)
    return project.assets.find((asset) => asset.id === target.assetId)?.title || 'Reference';
  if (target.screenId)
    return project.screens.find((screen) => screen.id === target.screenId)?.name || 'Screen';
  return 'Product discussion';
}

export default function AnnotationPanel({
  project,
  onChange,
  target,
  onClose,
  onToast,
  filter,
  selectedId,
}: Props) {
  const [body, setBody] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = useState<string>();
  const [showResolved, setShowResolved] = useState(false);
  const [composing, setComposing] = useState(Boolean(target));
  const panelRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (target) {
      setComposing(true);
      composerRef.current?.focus();
    }
  }, [target]);
  useEffect(() => {
    if (!selectedId) return;
    if (project.comments.find((comment) => comment.id === selectedId)?.status === 'resolved')
      setShowResolved(true);
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(`comment-${selectedId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);

  const filtered = project.comments.filter(
    (comment) =>
      (!filter?.screenId || comment.target.screenId === filter.screenId) &&
      (!filter?.assetId || comment.target.assetId === filter.assetId),
  );
  const visible = filtered.filter((comment) => showResolved || comment.status !== 'resolved');
  const resolvedCount = filtered.filter((comment) => comment.status === 'resolved').length;
  const updateComment = (id: string, update: Partial<Annotation>) => {
    const previous = project.comments.find((comment) => comment.id === id);
    const reopeningDecision = previous?.status === 'accepted' && update.status === 'open';
    onChange({
      ...project,
      comments: project.comments.map((comment) =>
        comment.id === id ? { ...comment, ...update } : comment,
      ),
      requirements: reopeningDecision
        ? project.requirements.map((requirement) =>
            requirement.id === previous.requirementId || requirement.sourceCommentId === id
              ? { ...requirement, status: 'proposed' }
              : requirement,
          )
        : project.requirements,
    });
  };

  function submitComment() {
    if (!body.trim()) return;
    if (project.comments.length >= 500) {
      onToast(
        'This project has reached its limit of 500 comments. Start a new project for additional feedback.',
      );
      return;
    }
    const fallback: AnnotationTarget = filter?.assetId
      ? { kind: 'asset', assetId: filter.assetId, x: 0.5, y: 0.5 }
      : filter?.screenId
        ? { kind: 'screen', screenId: filter.screenId, x: 0.5, y: 0.5 }
        : { kind: 'project', x: 0.5, y: 0.5 };
    const annotation: Annotation = {
      id: uid('comment'),
      target: target || fallback,
      body: body.trim(),
      status: 'open',
      replies: [],
      createdAt: new Date().toISOString(),
    };
    onChange({ ...project, comments: [...project.comments, annotation] });
    setBody('');
    setComposing(false);
    onToast('Comment added.');
  }

  function acceptComment(comment: Annotation) {
    const existing = project.requirements.find(
      (requirement) =>
        requirement.id === comment.requirementId || requirement.sourceCommentId === comment.id,
    );
    if (!existing && project.requirements.length >= 500) {
      onToast('This project has reached its limit of 500 requirements.');
      return;
    }
    const requirementId = existing?.id || uid('req');
    onChange({
      ...project,
      comments: project.comments.map((item) =>
        item.id === comment.id ? { ...item, status: 'accepted', requirementId } : item,
      ),
      requirements: existing
        ? project.requirements.map((item) =>
            item.id === existing.id ? { ...item, status: 'accepted' } : item,
          )
        : [
            ...project.requirements,
            {
              id: requirementId,
              text: comment.body,
              sourceCommentId: comment.id,
              screenId: comment.target.screenId,
              status: 'accepted',
            },
          ],
    });
    onToast('Accepted as a requirement. It will be included in the handoff.');
  }

  return (
    <aside className="annotations-panel" ref={panelRef} aria-label="Comments and decisions">
      <div className="annotations-heading">
        <div>
          <MessageCircle size={17} />
          <h3>Comments</h3>
          <span className="annotation-count">{filtered.length}</span>
        </div>
        {onClose && (
          <button type="button" className="an-icon" onClick={onClose} aria-label="Close comments">
            <X size={17} />
          </button>
        )}
      </div>
      <div className="annotations-subheading">Turn conversations into clear decisions.</div>
      {resolvedCount > 0 && (
        <label className="annotations-resolved-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />
          Show resolved ({resolvedCount})
        </label>
      )}
      <div className="annotation-thread-list">
        {visible.length === 0 && (
          <div className="annotation-empty">
            <span>
              <MessageCircle size={25} strokeWidth={1.5} />
            </span>
            <strong>A little context goes a long way</strong>
            <p>
              Pin a thought to the design. Accept it when you’re ready to make it a requirement.
            </p>
          </div>
        )}
        {visible.map((comment, index) => (
          <article
            key={comment.id}
            id={`comment-${comment.id}`}
            className={`annotation-thread ${comment.id === selectedId ? 'is-selected' : ''}`}
          >
            <div className="annotation-thread-meta">
              <span className="annotation-avatar">Y</span>
              <strong>You</strong>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
              <span className={`annotation-status is-${comment.status}`}>
                {comment.status === 'accepted' ? (
                  <CheckCheck size={12} />
                ) : comment.status === 'resolved' ? (
                  <Check size={12} />
                ) : (
                  <span className="annotation-status-dot" />
                )}
                {comment.status}
              </span>
            </div>
            <div className="annotation-target">
              <span>{index + 1}</span>
              {targetLabel(comment.target, project)}
              {comment.target.kind === 'node' && <small> · Element</small>}
            </div>
            {comment.previousLocation && (
              <div className="annotation-previous-location">
                Previously on {comment.previousLocation}
              </div>
            )}
            <p className="annotation-body">{comment.body}</p>
            {comment.requirementId && (
              <a href={`#requirement-${comment.requirementId}`} className="annotation-requirement">
                <CheckCheck size={13} /> Linked requirement <ArrowUpRight size={12} />
              </a>
            )}
            <div className="annotation-actions">
              <button
                type="button"
                onClick={() => setReplyingTo(replyingTo === comment.id ? undefined : comment.id)}
              >
                <MessageCircle size={13} />
                Reply{comment.replies.length ? ` (${comment.replies.length})` : ''}
              </button>
              {comment.status !== 'accepted' && (
                <button
                  type="button"
                  onClick={() => acceptComment(comment)}
                  title="Include this comment as an accepted requirement"
                >
                  <CheckCheck size={13} />
                  Accept
                </button>
              )}
              {comment.status === 'open' ? (
                <button
                  type="button"
                  onClick={() => updateComment(comment.id, { status: 'resolved' })}
                >
                  <Check size={13} />
                  Resolve
                </button>
              ) : (
                <button type="button" onClick={() => updateComment(comment.id, { status: 'open' })}>
                  <RotateCcw size={12} />
                  Reopen
                </button>
              )}
            </div>
            {comment.replies.length > 0 && (
              <div className="annotation-replies">
                {comment.replies.map((reply) => (
                  <div key={reply.id} className="annotation-reply">
                    <CornerDownRight size={13} />
                    <div>
                      <strong>
                        You{' '}
                        <time dateTime={reply.createdAt}>
                          {new Date(reply.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      </strong>
                      <p>{reply.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {replyingTo === comment.id && (
              <form
                className="annotation-reply-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = replies[comment.id]?.trim();
                  if (!value) return;
                  if (comment.replies.length >= 100) {
                    onToast(
                      'This thread has reached its limit of 100 replies. Start a new comment to continue the discussion.',
                    );
                    return;
                  }
                  updateComment(comment.id, {
                    replies: [
                      ...comment.replies,
                      { id: uid('reply'), body: value, createdAt: new Date().toISOString() },
                    ],
                  });
                  setReplies({ ...replies, [comment.id]: '' });
                  setReplyingTo(undefined);
                }}
              >
                <label className="an-sr-only" htmlFor={`reply-${comment.id}`}>
                  Reply to comment
                </label>
                <textarea
                  id={`reply-${comment.id}`}
                  value={replies[comment.id] || ''}
                  autoFocus
                  placeholder="Add to the conversation…"
                  rows={2}
                  maxLength={8000}
                  onChange={(event) => setReplies({ ...replies, [comment.id]: event.target.value })}
                />
                <button
                  type="submit"
                  className="an-icon an-send"
                  disabled={!replies[comment.id]?.trim()}
                  aria-label="Send reply"
                >
                  <Send size={15} />
                </button>
              </form>
            )}
          </article>
        ))}
      </div>
      <div className="annotation-compose-area">
        {composing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitComment();
            }}
          >
            <div className="annotation-compose-label">
              <span>
                <span className="annotation-compose-dot" />
                {target ? 'Comment at selected location' : 'New comment'}
              </span>
              <button
                type="button"
                className="an-icon"
                aria-label="Cancel comment"
                onClick={() => {
                  setComposing(false);
                  setBody('');
                }}
              >
                <X size={15} />
              </button>
            </div>
            <textarea
              ref={composerRef}
              aria-label="New comment"
              value={body}
              autoFocus
              rows={4}
              maxLength={8000}
              placeholder="What should happen here?"
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  submitComment();
                }
              }}
            />
            <div className="annotation-compose-footer">
              <span>⌘ / Ctrl + Enter to post</span>
              <button type="submit" className="an-primary" disabled={!body.trim()}>
                <Send size={13} />
                Post
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="annotation-new-button"
            onClick={() => setComposing(true)}
          >
            <Plus size={15} />
            Add a comment
          </button>
        )}
      </div>
    </aside>
  );
}
