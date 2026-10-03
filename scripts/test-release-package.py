#!/usr/bin/env python3
"""Release artifact regressions; standard library only, no network or providers."""
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("package_release", pathlib.Path(__file__).with_name("package-release.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ReleaseArtifacts(unittest.TestCase):
    def test_registry_urls_are_public_material(self):
        self.assertFalse(package.private_path('{"url":"https://registry.npmjs.org/zod/-/zod.tgz"}'))
        self.assertFalse(package.private_path('{"url":"git+https://github.com/example/repository.git"}'))

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
