import { describe, expect, it } from 'vitest';
import { createProject, type AIResult } from '../shared/model';
import { validateResultForJob } from '../worker/jobs';

const result: AIResult = {
  title: 'One more requirement',
  summary: 'Clarify acceptance criteria',
  reply: 'A proposed acceptance criterion.',
  plan: null,
  screens: null,
  design: null,
  requirements: [{ text: 'The user can export the accepted specification.' }],
};

describe('AI proposal composition', () => {
  it('rejects a result that exceeds the total requirement limit before publishing it', () => {
    const project = createProject();
    project.requirements = Array.from({ length: 500 }, (_, index) => ({
      id: `requirement_${index}`,
      text: `Existing requirement ${index}`,
      status: 'accepted',
    }));
    const job = {
      kind: 'plan.review' as const,
      screen_id: null,
      context: JSON.stringify(project),
    };
    expect(() => validateResultForJob(result, job)).toThrow(/project’s limits/);
    // A review with no additional requirements remains useful at capacity.
    expect(() => validateResultForJob({ ...result, requirements: [] }, job)).not.toThrow();
    expect(project.requirements).toHaveLength(500);
  });
});
