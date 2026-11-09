/**
 * The relational arm's review-packet evidence. PLACEHOLDER: to be written by the
 * independent designer (see docs/review-packet-design.md once written).
 */
import type { PacketEvidence } from '../commands/review.ts';
import type { Run } from '../run.ts';

export interface PacketEvidenceInput {
  run: Run;
  title: string;
  /** The rendered body (body:N numbering). */
  body: string;
  /** body.md as drafted, with its ref tags. */
  draft?: string;
  patch: string;
}

export function buildPacketEvidence(
  _input: PacketEvidenceInput,
): PacketEvidence | undefined {
  return undefined;
}
