"""No sudo, real credentials, network, or host systemd are used."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("bootstrap", ROOT / "deploy/infer-passthrough/bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.etc = self.root / "etc"
        self.units = self.root / "units"
        self.bundle = ROOT / "deploy/infer-passthrough"
        self.source = self.root / "private-home" / "checkout"
        for path in (self.state / "releases", self.etc, self.units, self.source):
            path.mkdir(parents=True)
        (self.source / "package.json").write_text(json.dumps({"version": "0.8.23"}))
        (self.source / "server.js").write_text("fixture")
        (self.source / "server.js").chmod(0o600)
        (self.source / ".env.local").write_text("not-copied")
        self.source.parent.chmod(0o750)
        self.env = self.etc / bootstrap.ENV
        self.env.write_text('INFER_PROXY_PRINCIPAL_DID="did:imajin:fixture"\n')
        self.env.chmod(0o600)
        self.route = self.etc / "routes.prod.json"
        self.route.write_text("{}")
        for name in bootstrap.UNIT_NAMES:
            (self.units / name).write_text("prior-unit")
        dropins = self.units / f"{bootstrap.SERVICE}.d"
        dropins.mkdir()
        (dropins / "override.conf").write_text("prior-dropin")
        self.trace = []
        self.failure = None
        self.inline = f'KERNEL_BASE_URL=https://kernel.test INFER_PROXY_HOST=127.0.0.1 INFER_PROXY_PORT=8787 INFER_PROXY_ROUTES_CONFIG={self.route} "EXTRA=two words"'
        for name, value in (("STATE", self.state), ("ETC", self.etc),
                            ("UNITS", self.units), ("BUNDLE", self.bundle)):
            mock = patch.object(bootstrap, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def fake_run(self, *args):
        self.trace.append(args)
        if args == self.failure:
            raise subprocess.CalledProcessError(1, args)
        if "--property=Environment" in args:
            return self.inline
        if "--property=EnvironmentFiles" in args:
            return f"{self.env} (ignore_errors=no)"
        if "--property=WorkingDirectory" in args:
            return str(self.source)
        return ""

    def migrate(self):
        with patch.object(bootstrap, "run", self.fake_run), patch.object(
                bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
            bootstrap.migrate()

    def test_migrates_inline_values_preserves_file_and_moves_routes_to_private_trash(self):
        self.migrate()
        values = bootstrap.assignments(self.env.read_text())
        self.assertEqual(values["KERNEL_BASE_URL"], "https://kernel.test")
        self.assertEqual(values["EXTRA"], "two words")
        self.assertEqual(values["INFER_PROXY_PRINCIPAL_DID"], "did:imajin:fixture")
        self.assertNotIn(bootstrap.ROUTES, values)
        self.assertFalse(self.route.exists())
        trash = next(path for path in self.state.glob("bootstrap-*") if path.is_dir())
        self.assertEqual((trash / "routes").read_text(), "{}")
        self.assertEqual(trash.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        current = (self.state / "current").resolve()
        self.assertEqual(current.parent, self.state / "releases")
        self.assertTrue(current.name.startswith("initial-v0.8.23-"))
        self.assertEqual(current.stat().st_mode & 0o777, 0o755)
        self.assertEqual((current / "server.js").stat().st_mode & 0o777, 0o644)
        self.assertFalse((current / ".env.local").exists())
        self.assertIn(("systemctl", "start", "infer-passthrough-update.service"), self.trace)
        self.assertIn(("systemctl", "enable", "--now", "infer-passthrough-update.timer"), self.trace)
        self.assertFalse(any("restart" in call for call in self.trace))
        self.assertTrue((self.state / "bootstrap-complete").exists())
        self.assertIn("WorkingDirectory=/var/lib/imajin/infer-passthrough/current",
                      (self.units / bootstrap.SERVICE).read_text())
        self.assertFalse((self.units / f"{bootstrap.SERVICE}.d").exists())
        if os.geteuid() == 0:
            self.assertEqual(current.stat().st_uid, 0)

    def test_file_values_win_and_rewriting_is_idempotent(self):
        first, route = bootstrap.migrated_environment("A=inline B=keep", 'A="file"\n')
        second, _ = bootstrap.migrated_environment("", first)
        self.assertEqual(first, second)
        self.assertEqual(bootstrap.assignments(first), {"A": "file", "B": "keep"})
        self.assertIsNone(route)

    def test_completed_run_is_noop_even_without_credential(self):
        (self.state / "bootstrap-complete").write_text("1\n")
        with patch.object(bootstrap.os, "geteuid", return_value=0), patch.object(
                bootstrap.sys, "argv", ["bootstrap.py"]), patch.object(
                bootstrap, "trusted"), patch.object(bootstrap, "run") as run:
            bootstrap.main()
        run.assert_not_called()

    def test_failure_restores_units_env_routes_and_previous_link_and_can_retry(self):
        previous = self.state / "previous"
        previous.mkdir()
        (self.state / "current").symlink_to(previous)
        before = self.env.read_bytes()
        self.failure = ("systemctl", "start", "infer-passthrough-update.service")
        with self.assertRaises(subprocess.CalledProcessError):
            self.migrate()
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(self.route.read_text(), "{}")
        self.assertEqual((self.state / "current").resolve(), previous)
        self.assertEqual((self.units / bootstrap.SERVICE).read_text(), "prior-unit")
        self.assertEqual((self.units / f"{bootstrap.SERVICE}.d/override.conf").read_text(), "prior-dropin")
        self.assertFalse((self.state / "bootstrap-complete").exists())
        self.failure = None
        self.migrate()
        self.assertTrue((self.state / "bootstrap-complete").exists())

    def test_first_install_failure_restores_old_unit_without_current(self):
        self.failure = ("systemctl", "enable", "--now", "infer-passthrough-update.timer")
        with self.assertRaises(subprocess.CalledProcessError):
            self.migrate()
        self.assertFalse((self.state / "current").exists())
        self.assertTrue(self.route.exists())
        self.assertFalse((self.state / "bootstrap-complete").exists())
        self.assertIn(("systemctl", "restart", bootstrap.SERVICE), self.trace)

    def test_missing_or_empty_credential_fails_before_any_mutation(self):
        with patch.object(bootstrap.os, "geteuid", return_value=0), patch.object(
                bootstrap.sys, "argv", ["bootstrap.py"]), patch.object(
                bootstrap, "trusted"), patch.object(bootstrap, "run") as run:
            for exists in (False, True):
                if exists:
                    (self.etc / "infer-passthrough-github-token").touch(mode=0o600)
                with self.assertRaises((FileNotFoundError, ValueError)):
                    bootstrap.main()
            run.assert_not_called()

    def test_unprivileged_or_arguments_are_refused(self):
        for uid, argv in ((1000, ["bootstrap.py"]), (0, ["bootstrap.py", "/tmp/code"])):
            with patch.object(bootstrap.os, "geteuid", return_value=uid), patch.object(
                    bootstrap.sys, "argv", argv), self.assertRaises(ValueError):
                bootstrap.main()

    def test_rejects_writable_and_symlinked_trusted_paths(self):
        target = self.root / "writable"
        target.touch(mode=0o666)
        target.chmod(0o666)
        with self.assertRaises(ValueError):
            bootstrap.trusted(target)
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            bootstrap.trusted(link)

    def test_invalid_environment_is_rejected(self):
        for text in ('not-an-assignment', 'BAD-NAME=x', 'A="unterminated', 'GH_TOKEN=fixture',
                     'GITHUB_TOKEN=fixture', 'INFER_UPDATE_GITHUB_TOKEN=fixture', 'A="line\nbreak"'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                bootstrap.migrated_environment(text, "")
        with self.assertRaises(ValueError):
            bootstrap.migrated_environment("", "A=continued\\\nB=x")

    def test_rejects_route_paths_outside_etc_and_invalid_ports(self):
        for inline in ("INFER_PROXY_ROUTES_CONFIG=/tmp/outside", "INFER_PROXY_PORT=8788",
                       "INFER_PROXY_PORT=0", "INFER_PROXY_PORT=65536"):
            self.inline = inline
            with self.subTest(inline=inline), self.assertRaises(ValueError):
                self.migrate()
            self.assertFalse((self.state / "bootstrap-complete").exists())

    def test_invalid_seed_version_is_rejected(self):
        (self.source / "package.json").write_text('{"version":"../../outside"}')
        with self.assertRaises(ValueError):
            bootstrap.seed_current(self.source, self.state)


if __name__ == "__main__":
    unittest.main()
