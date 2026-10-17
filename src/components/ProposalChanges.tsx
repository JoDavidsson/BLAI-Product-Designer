import { PLAN_FIELDS, type AIProposal, type Project, type WireNode } from '../../shared/model';

function Structure({ nodes }: { nodes: WireNode[] }) {
  if (!nodes.length) return <p className="muted">No components.</p>;
  return (
    <ul className="proposal-structure">
      {nodes.map((node) => (
        <li key={node.id}>
          <strong>{node.name || node.type}</strong> <small>{node.type}</small>
          {node.text && <p>{node.text}</p>}
          {node.action && <small>Opens screen: {node.action.screenId}</small>}
          {Object.keys(node.style).length > 0 && (
            <p className="proposal-style">
              {Object.entries(node.style)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ')}
            </p>
          )}
          {node.children.length > 0 && <Structure nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

export default function ProposalChanges({
  project,
  proposal,
}: {
  project: Project;
  proposal: AIProposal;
}) {
  const { result, kind } = proposal;
  const planning = kind === 'plan.assist' || kind === 'plan.review';
  const screens =
    kind === 'wireframe.generate' || kind === 'wireframe.refine' ? result.screens : null;
  const design =
    kind === 'moodboard.direction' || kind === 'wireframe.generate' ? result.design : null;
  const palette = design
    ? Object.entries(design).filter(
        ([key, value]) => value !== project.design[key as keyof typeof design],
      )
    : [];
  return (
    <div className="proposal-changes">
      {planning &&
        PLAN_FIELDS.filter(
          ([key]) => result.plan?.[key] !== undefined && result.plan[key] !== project.plan[key],
        ).map(([key, label]) => (
          <section className="proposal-comparison" key={key}>
            <h4>{label}</h4>
            <div className="comparison-columns">
              <div>
                <span>Current</span>
                <p>{project.plan[key] || 'Not written yet'}</p>
              </div>
              <div>
                <span>Proposed</span>
                <p>{result.plan![key] || 'Clear this section'}</p>
              </div>
            </div>
          </section>
        ))}
      {screens && (
        <section className="proposal-screen-changes">
          <h4>{kind === 'wireframe.generate' ? 'A complete screen draft' : 'Screen refinement'}</h4>
          <p>
            {kind === 'wireframe.generate'
              ? `Replace ${project.screens.length} existing screens with ${screens.length} proposed screens. Notes on removed components remain in project discussion.`
              : 'Replace the selected screen. Other screens stay as they are.'}
          </p>
          {screens.map((screen) => (
            <details key={screen.id}>
              <summary>
                {screen.name}{' '}
                <small>
                  {screen.platform} · {screen.state}
                </small>
              </summary>
              <p>{screen.description}</p>
              <Structure nodes={screen.nodes} />
            </details>
          ))}
        </section>
      )}
      {palette.length > 0 && (
        <section className="proposal-design-changes">
          <h4>Design changes</h4>
          <dl>
            {palette.map(([key, value]) => (
              <div key={key}>
                <dt>{key === 'radius' ? 'Corner radius' : key === 'font' ? 'Typeface' : key}</dt>
                <dd>
                  <span>
                    {String(project.design[key as keyof typeof project.design]).startsWith('#') && (
                      <i
                        style={{
                          background: String(project.design[key as keyof typeof project.design]),
                        }}
                      />
                    )}
                    {project.design[key as keyof typeof project.design]}
                  </span>
                  <span aria-label="changes to">→</span>
                  <span>
                    {String(value).startsWith('#') && <i style={{ background: String(value) }} />}
                    {value}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {result.requirements.length > 0 && (
        <section>
          <h4>{result.requirements.length} requirements to accept</h4>
          <p>Applying this proposal accepts these requirements.</p>
          <ul className="proposal-requirements">
            {result.requirements.map((requirement, index) => (
              <li key={index}>
                {requirement.text}
                {requirement.screenId && (
                  <small>
                    {' '}
                    · Applies to{' '}
                    {screens?.find((screen) => screen.id === requirement.screenId)?.name ||
                      project.screens.find((screen) => screen.id === requirement.screenId)?.name ||
                      requirement.screenId}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
