/**
 * Write-scope glob semantics.
 *
 * Both agents MUST use this module so "does scope A overlap scope B" has one answer.
 * Divergent glob implementations would silently allow conflicting writes, which is
 * exactly the failure this bridge exists to prevent.
 *
 * Supported syntax (intentionally small):
 *   `*`   matches any run of characters except `/`
 *   `**`  matches any run of characters including `/`
 *   `?`   matches exactly one character except `/`
 *   trailing `/` is normalised away; a bare directory implies `dir/**`
 */

import { invalidArgument } from "./errors.js";
import type { WriteScope } from "./types.js";

/** Normalise a path or pattern: POSIX separators, no leading `./`, no trailing `/`. */
export function normalizePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw invalidArgument("path must be a non-empty string", { value: p });
  }
  let out = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  if (out.includes("..")) {
    throw invalidArgument("path must not contain '..' segments", { value: p });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile a glob into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let re = "";
  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**` — crossing separators. `a/**` should also match `a` itself.
        const precededBySlash = re.endsWith("/");
        let j = i + 2;
        if (g[j] === "/") j += 1;
        if (precededBySlash) {
          re = re.slice(0, -1) + "(?:/.*)?";
        } else {
          re += ".*";
        }
        i = j;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += escapeRegex(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Does a concrete path fall inside a glob? */
export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

/**
 * Conservative overlap test between two glob patterns.
 *
 * Exact glob intersection is undecidable in general for arbitrary patterns, so this
 * errs toward reporting overlap (false positives block a write; false negatives would
 * corrupt state). Strategy: reduce each pattern to its literal prefix — the part before
 * the first wildcard — and check prefix containment, then confirm with direct matching.
 */
export function globsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;

  // Direct containment: one pattern's literal form matches the other's glob.
  if (!hasWildcard(na) && matchesGlob(na, nb)) return true;
  if (!hasWildcard(nb) && matchesGlob(nb, na)) return true;

  const pa = literalPrefix(na);
  const pb = literalPrefix(nb);

  // If neither has a wildcard they'd have been equal above.
  if (!hasWildcard(na) && !hasWildcard(nb)) return false;

  // Prefixes must be compatible for any concrete path to satisfy both.
  const shorter = pa.length <= pb.length ? pa : pb;
  const longer = pa.length <= pb.length ? pb : pa;
  if (shorter.length === 0) return true; // one pattern is rooted at repo root
  if (!longer.startsWith(shorter)) return false;

  // `packages/a*` vs `packages/b*` share the prefix `packages/` but cannot both match.
  const restA = na.slice(shorter.length);
  const restB = nb.slice(shorter.length);
  const litA = literalPrefix(restA);
  const litB = literalPrefix(restB);
  const minLit = Math.min(litA.length, litB.length);
  if (minLit > 0 && litA.slice(0, minLit) !== litB.slice(0, minLit)) return false;

  return true;
}

function hasWildcard(g: string): boolean {
  return g.includes("*") || g.includes("?");
}

function literalPrefix(g: string): string {
  const idx = [g.indexOf("*"), g.indexOf("?")].filter((i) => i >= 0);
  if (idx.length === 0) return g;
  return g.slice(0, Math.min(...idx));
}

/** Do two write scopes conflict? True if any pattern pair overlaps. */
export function scopesConflict(a: WriteScope, b: WriteScope): boolean {
  return conflictingPairs(a, b).length > 0;
}

/** Every overlapping pattern pair, for error reporting. */
export function conflictingPairs(a: WriteScope, b: WriteScope): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const pa of a.paths) {
    for (const pb of b.paths) {
      if (globsOverlap(pa, pb)) pairs.push([pa, pb]);
    }
  }
  return pairs;
}

/** Is `path` writable under `scope`? */
export function scopeAllows(scope: WriteScope, path: string): boolean {
  return scope.paths.some((p) => matchesGlob(path, p));
}

export function normalizeScope(scope: WriteScope): WriteScope {
  if (!Array.isArray(scope?.paths) || scope.paths.length === 0) {
    throw invalidArgument("write scope must declare at least one path");
  }
  const seen = new Set<string>();
  for (const p of scope.paths) seen.add(normalizePath(p));
  return { paths: [...seen].sort(), ...(scope.note ? { note: scope.note } : {}) };
}
