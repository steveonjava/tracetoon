/**
 * Claim checks that need the evidence graph: they compare a description's
 * sentences with what each commit message says, and about which code. Advisory, like the rest of the claim check; each
 * finding names the evidence so the writer can qualify the sentence.
 */
import type { ClaimFinding } from '../digest/claims.ts';
import { withGraph } from './engine.ts';
import type { EvidenceGraph } from './model.ts';

export interface GraphClaimFacts {
  /** One commit-message sentence, with the commit it belongs to. */
  commitClaims: { id: string; commit: string; text: string; assertsResult: boolean }[];
  /** Commits whose lines are in the PR. */
  commits: string[];
  /** Result lines of every captured run and receipt, to tell a run result from a message. */
  runResults: string[];
}

export function graphClaimFacts(graph: EvidenceGraph): GraphClaimFacts | undefined {
  try {
    return withGraph(graph, (g) => ({
      commitClaims: g
        .run(
          'MATCH (m:CommitClaim) RETURN m.id AS id, m.commit AS commit, m.text AS text, m.assertsResult AS assertsResult',
        )
        .rows.map((r) => ({
          id: String(r.id),
          commit: String(r.commit),
          text: String(r.text),
          assertsResult: !!r.assertsResult,
        })),
      commits: g
        .run('MATCH (k:Commit)-[:INTRODUCED]->(:Hunk) RETURN DISTINCT k.id AS id')
        .rows.map((r) => String(r.id))
        .sort(),
      runResults: g
        .run(
          'MATCH (r) WHERE r:Run OR r:Receipt RETURN r.summary AS summary, r.cmd AS cmd',
        )
        .rows.flatMap((r) => [...((r.summary as string[]) ?? []), String(r.cmd ?? '')]),
    }));
  } catch {
    return undefined;
  }
}

const words = (t: string) =>
  new Set(
    (t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)),
  );
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'its',
  'are',
  'was',
  'were',
  'now',
  'not',
  'but',
  'into',
  'out',
  'has',
  'have',
  'had',
  'they',
  'them',
  'also',
  'pr',
  'when',
  'than',
  'then',
  'which',
  'what',
  'their',
  'there',
  'these',
  'those',
]);
/** Share of the commit sentence's words the description sentence repeats. */
function overlap(sentence: string, claim: string): number {
  const a = words(sentence);
  const b = [...words(claim)];
  if (b.length < 3) return 0;
  return b.filter((w) => a.has(w)).length / b.length;
}

const RESULT_TOKEN =
  /\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:pass|passed|passing|tests?|checks?)\b/gi;
const MOTIVE =
  /\b(found|discovered|caught|noticed|spotted|surfaced)\s+(?:while|during|in|by)\b|\bdogfood\w*|\brequested by\b|\breported by\b/i;
const GENERAL =
  /\b(all|both|each|every|three|four|five|several|these|the)\s+(?:of\s+(?:the|these)\s+)?(?:fix|fixes|changes|bugs|issues|problems)\b|\b(?:fixes|changes|bugs)\b[^.]{0,40}\b(?:all|each)\b/i;

const finding = (
  quote: string,
  kind: ClaimFinding['kind'],
  detail: string,
  evidence: string[],
): ClaimFinding => ({ quote, kind, state: 'not established', detail, evidence });

/** Graph-backed findings for one sentence. */
export function checkGraphClaims(s: string, facts: GraphClaimFacts): ClaimFinding[] {
  const out: ClaimFinding[] = [];
  const attributedToMessage =
    /\bcommit (messages?|body|bodies)\b|\bcommits?\b[^.]{0,20}\b(say|says|report|reports|note|notes)\b|\b(?:per|according to) (?:the )?commits?\b/i.test(
      s,
    );

  // A result number that only a commit message reports, never a captured run.
  for (const m of s.match(RESULT_TOKEN) ?? []) {
    const token = m.replace(/\s+/g, '').toLowerCase();
    const norm = (t: string) => t.replace(/\s+/g, '').toLowerCase();
    if (facts.runResults.some((r) => norm(r).includes(token))) continue;
    const said = facts.commitClaims.filter(
      (c) => c.assertsResult && norm(c.text).includes(token),
    );
    if (said.length && !attributedToMessage) {
      out.push(
        finding(
          s,
          'verification',
          `"${m}" appears only in the message of commit ${said[0]!.commit}, not in any captured run; say the commit message reports it, or cite a run.`,
          said.map((c) => c.id),
        ),
      );
      break;
    }
  }

  // A motivation one commit gives, generalized to several.
  if (
    MOTIVE.test(s) &&
    GENERAL.test(s) &&
    facts.commits.length > 1 &&
    !attributedToMessage
  ) {
    const giving = [
      ...new Set(
        facts.commitClaims
          .filter((c) => MOTIVE.test(c.text) && overlap(s, c.text) >= 0.3)
          .map((c) => c.commit),
      ),
    ];
    const others = facts.commits.filter((k) => !giving.includes(k));
    if (giving.length && others.length)
      out.push(
        finding(
          s,
          'attribution',
          `Only commit${giving.length > 1 ? 's' : ''} ${giving.join(', ')} give${giving.length > 1 ? '' : 's'} this reason; ${others.join(', ')} ${others.length > 1 ? "don't" : "doesn't"}. Attribute the reason to the change it belongs to.`,
          facts.commitClaims
            .filter((c) => giving.includes(c.commit) && MOTIVE.test(c.text))
            .map((c) => c.id),
        ),
      );
  }
  return out;
}
