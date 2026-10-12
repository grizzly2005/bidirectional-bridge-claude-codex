#!/usr/bin/env python3
"""Package one clean, built Git commit. Python standard library only; no private state."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST_DIRS = (
    "shared/protocol/dist", "shared/control-plane/dist", "shared/mcp-server-core/dist",
    "claude/claude-side/dist", "codex/codex-side/dist", "shared/web-audit/dist",
)
WORKSPACES = tuple(pathlib.PurePosixPath(p).parent.as_posix() for p in DIST_DIRS)
# Web audit has its own experimental module version; bridge packages share the checkpoint.
INDEPENDENT_WORKSPACES = frozenset({"shared/web-audit"})


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not name:
        raise ValueError("unsafe archive member")


def private_path(text):
    # A drive prefix must start a value/token: the trailing 's:/' in 'https://' is a URL.
    return re.search(r'(?:^|[\s"(=])(?:[A-Za-z]:[\\/]|/home/|/Users/|/mnt/[a-z]/Users/)', text) is not None


def validate_package_versions(source):
    root = json.loads(source["package.json"][0])
    version = root["version"]
    if not re.fullmatch(r"0\.[0-9]+\.[0-9]+", version):
        raise ValueError("expected a pre-1.0 semantic version")
    if f'BRIDGE_VERSION = "{version}"' not in source["shared/protocol/src/index.ts"][0].decode():
        raise ValueError("runtime release identity is stale")
    declared = {pathlib.PurePosixPath(name).parent.as_posix() for name in source
                if name.endswith("/package.json")
                and any(pathlib.PurePosixPath(name).parent.match(pattern)
                        for pattern in root["workspaces"])}
    if declared != set(WORKSPACES):
        raise ValueError("declared workspace and compiled distribution inventories differ")
    packages = {}
    for path in ("", *WORKSPACES):
        name = (path + "/" if path else "") + "package.json"
        package = json.loads(source[name][0])
        if not package.get("private") or not re.fullmatch(r"0\.[0-9]+\.[0-9]+", package["version"]):
            raise ValueError(f"workspace version/private flag differs: {name}")
        if path not in INDEPENDENT_WORKSPACES and package["version"] != version:
            raise ValueError(f"bridge workspace version differs: {name}")
        packages[path] = package
    versions = {package["name"]: package["version"] for package in packages.values()}
    for package in packages.values():
        for name, requirement in package.get("dependencies", {}).items():
            if name.startswith("@bridge/") and requirement != versions.get(name):
                raise ValueError("internal dependency version differs")
    lock = json.loads(source["package-lock.json"][0])
    for path, package in packages.items():
        if lock["packages"][path]["version"] != package["version"]:
            raise ValueError("lockfile workspace version differs")
    return version, {path or ".": package["version"] for path, package in packages.items()}


def validate_contract_versions(source):
    protocol = source["shared/protocol/src/index.ts"][0].decode()
    wire = re.search(r'export const PROTOCOL_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";', protocol)
    heading = re.search(r"^# Bridge protocol — v([0-9]+\.[0-9]+\.[0-9]+)$",
                        source["docs/PROTOCOL.md"][0].decode(), re.M)
    database = re.search(r"const SCHEMA_VERSION = ([0-9]+);",
                         source["shared/control-plane/src/store/sqlite-store.ts"][0].decode())
    memory = re.search(r"export interface MemoryNote extends MemoryNoteDraft\s*\{\s*readonly schema_version: ([0-9]+);",
                       source["shared/protocol/src/memory.ts"][0].decode())
    if not wire or not heading or wire.group(1) != heading.group(1):
        raise ValueError("wire version and protocol documentation differ")
    if not database or not memory:
        raise ValueError("persisted schema identity missing")
    return {"protocol_version": wire.group(1), "database_schema_version": int(database.group(1)),
            "memory_schema_version": int(memory.group(1))}


def archive(destination, prefix, entries, timestamp):
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name, (data, mode) in sorted(entries.items()):
            safe_name(name)
            info = zipfile.ZipInfo(prefix + name, timestamp)
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(destination) as target:
        if target.testzip() is not None:
            raise ValueError("archive integrity check failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sbom", required=True)
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("release output must be empty; published assets are never overwritten")
    subprocess.check_call(["git", "-C", str(ROOT), "diff", "--quiet", "HEAD", "--"])
    manifest = json.loads(git("show", "HEAD:certification/manifest-v1.json"))
    allowed = set(manifest["files"])
    source = {}
    for record in git("ls-tree", "-rz", "HEAD").split(b"\0"):
        if not record:
            continue
        meta, raw_name = record.split(b"\t", 1)
        mode, kind, object_id = meta.split()
        name = raw_name.decode("utf8")
        safe_name(name)
        if name not in allowed or kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError(f"unreviewed or non-regular source material: {name}")
        source[name] = (git("cat-file", "blob", object_id.decode()), int(mode, 8) & 0o777)
    if set(source) != allowed:
        raise ValueError("Git tree and public material manifest differ")
    version, workspace_versions = validate_package_versions(source)
    contract_versions = validate_contract_versions(source)
    built = {}
    for folder in DIST_DIRS:
        directory = ROOT / folder
        if not (directory / "index.js").is_file():
            raise ValueError(f"missing build: {folder}")
        for item in directory.rglob("*"):
            if item.is_symlink():
                raise ValueError("symlinks are not allowed in the distribution")
            if not item.is_file():
                continue
            name = item.relative_to(ROOT).as_posix()
            if not name.endswith((".js", ".d.ts", ".js.map", ".d.ts.map", ".html")):
                raise ValueError(f"unexpected build output: {name}")
            built[name] = (item.read_bytes(), 0o755 if item.read_bytes().startswith(b"#!/") else 0o644)
    if "shared/mcp-server-core/dist/tracking-ui.html" not in built:
        raise ValueError("tracking resource missing")
    stamp = int(git("show", "-s", "--format=%ct", "HEAD").strip())
    timestamp = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).timetuple()[:6]
    if timestamp[0] < 1980:
        timestamp = (1980, 1, 1, 0, 0, 0)
    commit = git("rev-parse", "HEAD").decode().strip()
    metadata = {
        "schema_version": 1, "version": version, "tag": "v" + version,
        "source_commit": commit, "source_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "node_requirement": json.loads(source["package.json"][0])["engines"]["node"],
        "workspace_versions": workspace_versions,
        **contract_versions,
        "source_file_count": len(source), "compiled_file_count": len(built),
        "lockfile_sha256": digest(source["package-lock.json"][0]),
        "files": {name: digest(data) for name, (data, _) in sorted({**source, **built}.items())},
        "build_evidence": "Fresh locked build required by release workflow; see GitHub Actions provenance.",
    }
    encoded = (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode()
    prefix = "bidirectional-bridge-" + version + "/"
    archive(output / ("bidirectional-bridge-" + version + "-source.zip"), prefix, source, timestamp)
    archive(output / ("bidirectional-bridge-" + version + "-compiled.zip"), prefix,
            {**source, **built, "RELEASE.json": (encoded, 0o644)}, timestamp)
    for skill_name in ("using-bridge", "bridge-web-audit"):
        skill_prefix = "skills/" + skill_name + "/"
        skill = {name.removeprefix(skill_prefix): value for name, value in source.items()
                 if name.startswith(skill_prefix)}
        if "SKILL.md" not in skill:
            raise ValueError(f"canonical skill missing: {skill_name}")
        archive(output / (skill_name + "-" + version + ".zip"), skill_name + "/", skill, timestamp)
    sbom = json.loads(pathlib.Path(args.sbom).read_text(encoding="utf-8-sig"))
    sbom_text = json.dumps(sbom, indent=2, sort_keys=True) + "\n"
    if private_path(sbom_text):
        raise ValueError("dependency inventory contains a local absolute path")
    (output / "SBOM.cdx.json").write_text(sbom_text, encoding="utf8", newline="\n")
    (output / "RELEASE.json").write_bytes(encoded)
    sums = "".join(digest(item.read_bytes()) + "  " + item.name + "\n" for item in sorted(output.iterdir()))
    (output / "SHA256SUMS.txt").write_text(sums, encoding="utf8", newline="\n")
    print(json.dumps({"version": version, "source_commit": commit, "assets": sorted(p.name for p in output.iterdir())}))


if __name__ == "__main__":
    main()
