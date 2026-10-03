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
    "claude/claude-side/dist", "codex/codex-side/dist",
)
WORKSPACES = tuple(pathlib.PurePosixPath(p).parent.as_posix() for p in DIST_DIRS)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or not name:
        raise ValueError("unsafe archive member")


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
    version = json.loads(source["package.json"][0])["version"]
    if not re.fullmatch(r"0\.[0-9]+\.[0-9]+", version):
        raise ValueError("expected a pre-1.0 semantic version")
    if f'BRIDGE_VERSION = "{version}"' not in source["shared/protocol/src/index.ts"][0].decode():
        raise ValueError("runtime release identity is stale")
    for path in ("", *WORKSPACES):
        manifest_name = (path + "/" if path else "") + "package.json"
        package = json.loads(source[manifest_name][0])
        if package["version"] != version or not package.get("private"):
            raise ValueError(f"workspace version/private flag differs: {manifest_name}")
        for name, requirement in package.get("dependencies", {}).items():
            if name.startswith("@bridge/") and requirement != version:
                raise ValueError("internal dependency version differs")
    lock = json.loads(source["package-lock.json"][0])
    for path in ("", *WORKSPACES):
        if lock["packages"][path]["version"] != version:
            raise ValueError("lockfile workspace version differs")
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
    skill = {name.removeprefix("skills/using-bridge/"): value for name, value in source.items()
             if name.startswith("skills/using-bridge/")}
    if "SKILL.md" not in skill:
        raise ValueError("canonical skill missing")
    archive(output / ("using-bridge-" + version + ".zip"), "using-bridge/", skill, timestamp)
    sbom = json.loads(pathlib.Path(args.sbom).read_text(encoding="utf-8-sig"))
    sbom_text = json.dumps(sbom, indent=2, sort_keys=True) + "\n"
    if re.search(r"(?:[A-Za-z]:[\\/]|/home/|/Users/|/mnt/[a-z]/Users/)", sbom_text):
        raise ValueError("dependency inventory contains a local absolute path")
    (output / "SBOM.cdx.json").write_text(sbom_text, encoding="utf8", newline="\n")
    (output / "RELEASE.json").write_bytes(encoded)
    sums = "".join(digest(item.read_bytes()) + "  " + item.name + "\n" for item in sorted(output.iterdir()))
    (output / "SHA256SUMS.txt").write_text(sums, encoding="utf8", newline="\n")
    print(json.dumps({"version": version, "source_commit": commit, "assets": sorted(p.name for p in output.iterdir())}))


if __name__ == "__main__":
    main()
