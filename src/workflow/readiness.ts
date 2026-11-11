import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../run.ts';
import { readJson } from '../run.ts';
import type { Approval } from '../commands/publish.ts';
import { receipts } from './checks.ts';
import { readTask, workFingerprint } from './state.ts';
import { git } from '../util/exec.ts';
import { objectHash } from '../contribution/guidance.ts';
import type { ReviewInput } from '../contribution/types.ts';
import type { TraceDigest } from '../digest/build.ts';
const originHash = (root: string) =>
  createHash('sha256')
    .update(git(root, ['remote', 'get-url', 'origin']).stdout.trim())
    .digest('hex');

export const fileHash = (run: Run, name: string) =>
  createHash('sha256')
    .update(readFileSync(join(run.dir, name)))
    .digest('hex');

function renderProblem(run: Run, approval: Approval): string | undefined {
  try {
    if (fileHash(run, 'final-body.md') !== approval.bodySha)
      return 'The rendered description changed; render and review it again.';
    const packet = readJson<ReviewInput>(run, 'review-input.json');
    if (
      !packet ||
      packet.title !== approval.title ||
      createHash('sha256').update(packet.body).digest('hex') !== approval.bodySha
    )
      return 'The reviewed title or description does not match this render.';
    if (
      packet.changeMapSha256 &&
      objectHash(readJson(run, 'change-map.json')) !== packet.changeMapSha256
    )
      return 'The change map changed after rendering; render and review it again.';
    if (packet.fullDigestSha256) {
      const full = readJson<TraceDigest>(run, 'digest-full.json');
      if (!full)
        return 'The full evidence is missing; refresh the digest and render again.';
      const { generatedAt: _time, ...stable } = full;
      if (objectHash(stable) !== packet.fullDigestSha256)
        return 'The full evidence changed after rendering; render and review it again.';
    }
    if (
      approval.comicFile &&
      createHash('sha256').update(readFileSync(approval.comicFile)).digest('hex') !==
        approval.comicSha
    )
      return 'The comic changed; render and review it again.';
  } catch {
    return 'A rendered artifact is missing; render again.';
  }
}

/**
 * What must hold before Tracetoon creates the PR. These guard against posting
 * something stale or unreviewed; none of them waits for a person.
 */
export function publishProblem(
  root: string,
  run: Run,
  approval: Approval,
): string | undefined {
  if (existsSync(join(run.dir, 'checks.lock')))
    return 'Validation is still running; wait for it before publishing.';
  // An interrupted check has no result; finish or rerun it rather than post blind.
  const interrupted = receipts(run).find((c) => c.outcome === 'running');
  if (interrupted)
    return `Check ${interrupted.name} was interrupted. Rerun it (or record it with check --skip and a reason), then digest and render again.`;
  const integrity = renderProblem(run, approval);
  if (integrity) return integrity;
  const task = readTask(run);
  if (!task) return; // Manual workflows have no recorded review or checks to bind.
  try {
    if (
      approval.workspaceFingerprint &&
      approval.workspaceFingerprint !== workFingerprint(root)
    )
      return 'Working content changed after rendering; refresh the digest, review and render.';
    if (approval.originSha && approval.originSha !== originHash(root))
      return 'The publication remote changed after rendering; render again.';
    const checksSha = receipts(run).length ? fileHash(run, 'checks.json') : undefined;
    if (checksSha !== approval.checksSha)
      return 'Validation evidence changed after rendering; refresh the digest and render again.';
  } catch {
    return 'Preparation artifacts are missing; refresh this task.';
  }
  const review = readJson<{ status: string }>(run, 'review-result.json');
  // The lean brief path (render --lean) needs no separate review.
  if (review?.status === 'skipped') return;
  const input = readJson<{ fingerprint: string }>(run, 'review-input.json');
  const submitted = readJson<{ inputFingerprint: string }>(run, 'review.json');
  if (
    !review ||
    !['current', 'incomplete'].includes(review.status) ||
    !input ||
    input.fingerprint !== submitted?.inputFingerprint
  )
    return 'The independent review is missing or stale. Review the current review-input.json, then render again.';
}
