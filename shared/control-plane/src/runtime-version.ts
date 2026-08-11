/** Minimum Node release that exposes `node:sqlite` without an experimental CLI flag. */
export const MINIMUM_NODE_VERSION = "22.13.0";

const MINIMUM = [22, 13, 0] as const;

export function supportsBridgeNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < MINIMUM.length; index++) {
    if (actual[index]! > MINIMUM[index]!) return true;
    if (actual[index]! < MINIMUM[index]!) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (supportsBridgeNodeVersion(version)) return;
  throw new Error(
    `Bidirectional Bridge requires Node.js ${MINIMUM_NODE_VERSION} or newer because it uses ` +
      `node:sqlite without an experimental CLI flag; detected Node.js ${version}. ` +
      "Upgrade Node.js and retry.",
  );
}
