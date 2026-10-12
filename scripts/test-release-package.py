#!/usr/bin/env python3
"""Release artifact regressions; standard library only, no network or providers."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("package_release", pathlib.Path(__file__).with_name("package-release.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ReleaseArtifacts(unittest.TestCase):
    def version_fixture(self):
        names = ["package.json", "package-lock.json", "shared/protocol/src/index.ts"]
        names += [path + "/package.json" for path in package.WORKSPACES]
        return {name: ((package.ROOT / name).read_bytes(), 0o644) for name in names}

    def test_independent_web_module_and_lock_versions(self):
        source = self.version_fixture()
        version, workspace_versions = package.validate_package_versions(source)
        self.assertEqual(version, json.loads(source["package.json"][0])["version"])
        self.assertEqual(workspace_versions["shared/web-audit"],
                         json.loads(source["shared/web-audit/package.json"][0])["version"])
        lock = json.loads(source["package-lock.json"][0])
        lock["packages"]["shared/web-audit"]["version"] = "0.0.0"
        source["package-lock.json"] = (json.dumps(lock).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, "lockfile workspace version"):
            package.validate_package_versions(source)

    def test_missing_workspace_cannot_silently_disappear(self):
        source = self.version_fixture()
        source["shared/new-module/package.json"] = (
            b'{"name":"@bridge/new-module","version":"0.1.0","private":true}', 0o644)
        with self.assertRaisesRegex(ValueError, "inventories differ"):
            package.validate_package_versions(source)

    def test_bridge_version_drift_is_still_rejected(self):
        source = self.version_fixture()
        manifest = json.loads(source["shared/control-plane/package.json"][0])
        manifest["version"] = "0.0.0"
        source["shared/control-plane/package.json"] = (json.dumps(manifest).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, "bridge workspace version"):
            package.validate_package_versions(source)

    def test_internal_dependency_drift_is_rejected(self):
        source = self.version_fixture()
        manifest = json.loads(source["shared/control-plane/package.json"][0])
        manifest["dependencies"]["@bridge/protocol"] = "0.0.0"
        source["shared/control-plane/package.json"] = (json.dumps(manifest).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, "internal dependency version"):
            package.validate_package_versions(source)

    def test_registry_urls_are_public_material(self):
        self.assertFalse(package.private_path('{"url":"https://registry.npmjs.org/zod/-/zod.tgz"}'))
        self.assertFalse(package.private_path('{"url":"git+https://github.com/example/repository.git"}'))

    def test_stale_protocol_documentation_prevents_packaging(self):
        names = ["shared/protocol/src/index.ts", "shared/protocol/src/memory.ts", "docs/PROTOCOL.md",
                 "shared/control-plane/src/store/sqlite-store.ts"]
        source = {name: ((package.ROOT / name).read_bytes(), 0o644) for name in names}
        identities = package.validate_contract_versions(source)
        self.assertGreater(identities["database_schema_version"], 0)
        self.assertGreater(identities["memory_schema_version"], 0)
        source["docs/PROTOCOL.md"] = (b"# Bridge protocol \xe2\x80\x94 v0.0.0\n", 0o644)
        with self.assertRaisesRegex(ValueError, "wire version and protocol documentation differ"):
            package.validate_contract_versions(source)

    def test_private_paths_are_rejected(self):
        for text in ('C:\\Users\\example', '{"path":"C:/Users/example"}',
                     '{"path":"/home/example/project"}', '{"path":"/mnt/c/Users/example/project"}'):
            with self.subTest(text=text):
                self.assertTrue(package.private_path(text))

    def test_traversal_and_absolute_members_are_rejected(self):
        for name in ("../private", "/home/private", "source/../../private", "source\\private", ""):
            with self.subTest(name=name), self.assertRaises(ValueError):
                package.safe_name(name)

    def test_archive_roundtrip_and_executable_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / "release.zip"
            package.archive(archive, "project/", {"scripts/run.py": (b"#!/usr/bin/env python3\n", 0o755),
                                                   "skill.md": ("Délégation\n".encode(), 0o644)}, (2026, 10, 3, 12, 0, 0))
            with zipfile.ZipFile(archive) as target:
                self.assertIsNone(target.testzip())
                self.assertEqual(target.read("project/skill.md"), "Délégation\n".encode())
                self.assertEqual((target.getinfo("project/scripts/run.py").external_attr >> 16) & 0o777, 0o755)

    def test_member_order_does_not_change_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            first, second = pathlib.Path(folder) / "first.zip", pathlib.Path(folder) / "second.zip"
            entries = {"b.md": (b"b", 0o644), "a.md": (b"a", 0o644)}
            stamp = (2026, 10, 3, 12, 0, 0)
            package.archive(first, "project/", entries, stamp)
            package.archive(second, "project/", dict(reversed(list(entries.items()))), stamp)
            self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
