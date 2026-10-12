import type { Hypothesis, HypothesisDraft } from "./model.js";
import { digest } from "./model.js";
import { createHypothesis } from "./evidence.js";

/** Authored abstraction only: this API deliberately has no campaign/finding-to-pattern adapter. */
export interface AbstractPatternDraft {
  applicationContext: string;
  rootCause: string;
  suspicionSignals: string[];
  confirmationTest: string;
  refutationTest: string;
  variants: string[];
  provenance: { kind: "manually-authored-abstraction"; reviewedForTargetFacts: true; authoredAt: string };
}
export interface AbstractPattern extends AbstractPatternDraft { schemaVersion: 1; kind: "abstract-web-audit-pattern"; id: string }
export function authorPattern(value: unknown, forbiddenSourceTerms: string[] = []): AbstractPattern {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pattern must be an explicitly authored abstraction");
  const v = value as Record<string, unknown>;
  const keys = ["applicationContext", "rootCause", "suspicionSignals", "confirmationTest", "refutationTest", "variants", "provenance"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw new Error("Pattern contains unsupported/source-target fields");
  for (const k of ["applicationContext", "rootCause", "confirmationTest", "refutationTest"]) if (typeof v[k] !== "string" || !(v[k] as string).trim()) throw new Error(`Pattern ${k} must be authored text`);
  for (const k of ["suspicionSignals", "variants"]) if (!Array.isArray(v[k]) || !v[k].length || !(v[k] as unknown[]).every(s => typeof s === "string" && s.trim())) throw new Error(`Pattern ${k} must be authored text array`);
  const p = v.provenance as Record<string, unknown> | null;
  if (!p || Object.keys(p).sort().join(",") !== "authoredAt,kind,reviewedForTargetFacts" || p.kind !== "manually-authored-abstraction" || p.reviewedForTargetFacts !== true || typeof p.authoredAt !== "string" || !Number.isFinite(Date.parse(p.authoredAt))) throw new Error("Explicit abstraction review and authoredAt provenance required");
  const texts = [v.applicationContext, v.rootCause, v.confirmationTest, v.refutationTest, ...(v.suspicionSignals as string[]), ...(v.variants as string[])].map(String);
  // Catch common accidental transfers. Human abstraction review still has to catch arbitrary names/IDs.
  const concrete = [
    /https?:\/\/|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/i,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[a-f0-9:]+:[a-f0-9:]+\]/i,
    /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b|\b[a-f0-9]{32,}\b/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:authorization|cookie|session[_-]?id|api[ _-]?key|token)\s*[:=]\s*\S+|(?:ghp_|sk[-_]|AKIA)[A-Za-z0-9_-]{12,})/i,
    /\b(?:actor|user|tenant|object|account|session)[_-](?:\d+|[a-f0-9]{8,})\b|\b(?:actor|user|tenant|object|account)(?:Id|_id)\s*[:=]\s*\S+/i,
    /\bconfirmed-with-evidence\b|\b(?:verdict|status)\s*[:=]\s*(?:confirmed|rejected|vulnerable|safe|COMPLETE|tested-inconclusive)\b/i,
    /\/(?:[a-z0-9_-]+\/)+[a-z0-9_-]+(?:\b|[/?#])/i,
  ];
  if (texts.some(text => concrete.some(rule => rule.test(text)))) throw new Error("Abstract pattern contains a concrete host/identity/token/verdict-like string");
  const forbidden = forbiddenSourceTerms.filter(term => term.trim().length >= 4).map(term => term.toLowerCase());
  if (texts.some(text => forbidden.some(term => text.toLowerCase().includes(term)))) throw new Error("Abstract pattern repeats a supplied source-target fact");
  const draft = structuredClone(v) as unknown as AbstractPatternDraft;
  return { schemaVersion: 1, kind: "abstract-web-audit-pattern", id: `pattern-${digest(draft)}`, ...draft };
}
export function parsePattern(value: unknown): AbstractPattern {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pattern envelope");
  const { schemaVersion, kind, id, ...draft } = value as Record<string, unknown>;
  const authored = authorPattern(draft);
  if (schemaVersion !== 1 || kind !== authored.kind || id !== authored.id) throw new Error("Pattern envelope/digest mismatch");
  return authored;
}
export function instantiatePattern(pattern: AbstractPattern | unknown, targetBinding: HypothesisDraft, at = new Date().toISOString()): Hypothesis {
  const abstract = parsePattern(pattern);
  return createHypothesis({ ...targetBinding, patternId: abstract.id }, at, "Imported abstract pattern; all target facts and witnesses must be established anew");
}
