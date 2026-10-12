import { invalidArgument } from "./errors.js";
import { VerificationResultSchema } from "./schemas.js";
import { VerificationKind, type VerificationResult } from "./types.js";
import { assertValid } from "./validate.js";

/** One evidence contract for both runtimes and every control-plane entrypoint. */
export function validateVerificationResult(result: VerificationResult): VerificationResult {
  assertValid<VerificationResult>(result, VerificationResultSchema, "VerificationResult");
  if (result.exit_code !== null && result.passed !== (result.exit_code === 0)) {
    throw invalidArgument("verification passed flag contradicts exit_code", {
      command: result.command, passed: result.passed, exit_code: result.exit_code,
    });
  }
  if (result.kind !== VerificationKind.MANUAL && result.exit_code === null) {
    throw invalidArgument("command-based verification requires an exit_code", {
      command: result.command, kind: result.kind,
    });
  }
  return result;
}
