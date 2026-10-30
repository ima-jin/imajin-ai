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
        self.release = self.state / "releases" / ("f" * 40)
        for path in (self.state / "releases", self.etc, self.units, self.source):
            path.mkdir(parents=True)
        (self.source / "package.json").write_text(json.dumps({"version": "0.8.23"}))
        (self.source / "server.js").write_text("fixture")
        (self.source / "server.js").chmod(0o600)
        (self.source / ".env.local").write_text("not-copied")
        (self.source / ".npmrc").write_text("not-copied")
        (self.source / ".netrc").write_text("not-copied")
        self.source.parent.chmod(0o750)
        self.env = self.etc / bootstrap.ENV
        self.env.write_text('INFER_PROXY_PRINCIPAL_DID="did:imajin:fixture"\n')
        self.env.chmod(0o600)
        self.route = self.etc / "routes.prod.json"
        self.route.write_text("{}")
        self.prior_unit = f"prior-unit\nWorkingDirectory={self.source}\n"
        for name in bootstrap.UNIT_NAMES:
            (self.units / name).write_text(self.prior_unit if name == bootstrap.SERVICE else "prior-unit")
        dropins = self.units / f"{bootstrap.SERVICE}.d"
        dropins.mkdir()
        (dropins / "override.conf").write_text("prior-dropin")
        self.trace = []
        self.failure = None
        self.invocation = "a" * 32
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
            raise AssertionError("Bootstrap must not inspect the home checkout")
        if "--property=InvocationID" in args:
            return self.invocation
        if args == self.updater_command():
            self.release.mkdir(exist_ok=True)
            temporary = self.state / "current.test"
            temporary.symlink_to(self.release)
            temporary.replace(self.state / "current")
            self.invocation = "b" * 32
        return ""

    def updater_command(self):
        return ("env", "INFER_UPDATE_PORT=8787", str(self.bundle / "update.sh"), "--bootstrap")

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
        self.assertEqual(current, self.release)
        self.assertFalse((current / "server.js").exists())
        self.assertFalse((current / ".env.local").exists())
        self.assertFalse((current / ".npmrc").exists())
        self.assertFalse((current / ".netrc").exists())
        self.assertIn(self.updater_command(), self.trace)
        self.assertIn(("systemctl", "enable", "--now", "infer-passthrough-update.timer"), self.trace)
        self.assertFalse(any("restart" in call for call in self.trace))
        self.assertTrue((self.state / "bootstrap-complete").exists())
        self.assertIn("WorkingDirectory=/var/lib/imajin/infer-passthrough/current",
                      (self.units / bootstrap.SERVICE).read_text())
        self.assertFalse((self.units / f"{bootstrap.SERVICE}.d").exists())

    def test_never_reads_walks_or_copies_home_checkout_or_follows_its_symlinks(self):
        private = self.source / "server.js"
        target = self.source.parent / "private-target"
        target.write_text("private-fixture")
        target.chmod(0o600)
        (self.source / "link").symlink_to(target)
        original_open = Path.open
        original_copytree = bootstrap.shutil.copytree
        original_scandir = os.scandir

        def reject_home(path):
            if Path(path).is_relative_to(self.source.parent):
                raise AssertionError("Root accessed the user-writable home tree")

        def guarded_open(path, *args, **kwargs):
            reject_home(path)
            return original_open(path, *args, **kwargs)

        def guarded_copytree(source, *args, **kwargs):
            reject_home(source)
            return original_copytree(source, *args, **kwargs)

        def guarded_scandir(path):
            reject_home(path)
            return original_scandir(path)

        with patch.object(Path, "open", guarded_open), patch.object(
                bootstrap.shutil, "copytree", guarded_copytree), patch.object(
                os, "scandir", guarded_scandir), patch.object(
                os, "walk", side_effect=AssertionError("Root must not walk the checkout")):
            self.migrate()
        self.assertEqual(private.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.release / "server.js").exists())
        self.assertFalse((self.release / "link").exists())

    def test_file_values_win_and_rewriting_is_idempotent(self):
        first, route = bootstrap.migrated_environment("A=inline B=keep", 'A="file"\n')
        second, _ = bootstrap.migrated_environment("", first)
        self.assertEqual(first, second)
        self.assertEqual(bootstrap.assignments(first), {"A": "file", "B": "keep"})
        self.assertIsNone(route)

    def test_environment_literals_are_not_shell_expanded_or_treated_as_comments(self):
        content, _ = bootstrap.migrated_environment('A=literal#suffix B="$not_expanded" C=""', "")
        self.assertEqual(bootstrap.assignments(content),
                         {"A": "literal#suffix", "B": "$not_expanded", "C": ""})

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
        self.failure = self.updater_command()
        with self.assertRaises(subprocess.CalledProcessError):
            self.migrate()
        self.assertEqual(self.env.read_bytes(), before)
        self.assertEqual(self.route.read_text(), "{}")
        self.assertEqual((self.state / "current").resolve(), previous)
        self.assertEqual((self.units / bootstrap.SERVICE).read_text(), self.prior_unit)
        self.assertEqual((self.units / f"{bootstrap.SERVICE}.d/override.conf").read_text(), "prior-dropin")
        self.assertFalse((self.state / "bootstrap-complete").exists())
        self.assertNotIn(("systemctl", "restart", bootstrap.SERVICE), self.trace)
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
        self.assertEqual((self.units / bootstrap.SERVICE).read_text(), self.prior_unit)

    def test_rollback_preserves_home_link_text_without_resolving_it(self):
        previous = self.source / "unreadable-target"
        (self.state / "current").symlink_to(previous)
        self.failure = ("systemctl", "enable", "--now", "infer-passthrough-update.timer")
        with patch.object(Path, "resolve", side_effect=AssertionError("Must not resolve home links")):
            with self.assertRaises(subprocess.CalledProcessError):
                self.migrate()
        self.assertEqual(os.readlink(self.state / "current"), str(previous))
        self.assertEqual((self.units / bootstrap.SERVICE).read_text(), self.prior_unit)

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
        for text in ('not-an-assignment', 'BAD-NAME=x', 'Aé=x', 'A="unterminated', 'GH_TOKEN=fixture',
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


    def test_missing_service_invocation_refuses_without_mutation(self):
        self.invocation = ""
        with self.assertRaises(ValueError):
            self.migrate()
        self.assertTrue(self.route.exists())
        self.assertFalse((self.state / "current").exists())
        self.assertFalse(any("stop" in call or "restart" in call for call in self.trace))

    def test_additional_env_files_and_symlinked_routes_are_refused(self):
        def extra_files(*args):
            if "--property=EnvironmentFiles" in args:
                return f"{self.env} (ignore_errors=no) /tmp/other (ignore_errors=no)"
            return self.fake_run(*args)
        with patch.object(bootstrap, "run", extra_files), self.assertRaises(ValueError):
            bootstrap.migrate()
        self.route.unlink()
        self.route.symlink_to(self.env)
        with self.assertRaises(ValueError):
            self.migrate()

    def test_bootstrap_prerequisite_and_gate_refusals_precede_account_creation(self):
        bundle = self.root / "trusted-bundle"
        bundle.mkdir()
        (bundle / "release.sha").write_text("a" * 40)
        credential = self.etc / "infer-passthrough-github-token"
        credential.write_text("non-credential-fixture")
        credential.chmod(0o600)
        def commands(*args):
            self.trace.append(args)
            if args == ("node", "--version"):
                return self.node_version
            if args == ("pnpm", "--version"):
                return self.pnpm_version
            raise subprocess.CalledProcessError(2, args)
        self.node_version = "v24.0.0"
        self.pnpm_version = "9.15.0"
        with patch.object(bootstrap.os, "geteuid", return_value=0), patch.object(
                bootstrap.sys, "argv", ["bootstrap.py"]), patch.object(
                bootstrap, "trusted"), patch.object(bootstrap, "BUNDLE", bundle), patch.object(
                bootstrap, "run", commands), patch.object(bootstrap.shutil, "which", return_value="/bin/fixture"):
            # Unapproved or unavailable production evidence refuses before mutation.
            with self.assertRaises(subprocess.CalledProcessError):
                bootstrap.main()
            self.assertEqual(self.trace[-1], ("node", str(bundle / "production-deployment.mjs"), "a" * 40))
            for node, pnpm in (("v20.0.0", "9.15.0"), ("v24.0.0", "10.0.0")):
                self.node_version, self.pnpm_version = node, pnpm
                with self.assertRaises(ValueError):
                    bootstrap.main()
            self.node_version, self.pnpm_version = "v24.0.0", "9.15.0"
            (bundle / "release.sha").write_text("invalid-sha")
            with self.assertRaises(ValueError):
                bootstrap.main()
            with patch.object(bootstrap.shutil, "which", return_value=None), self.assertRaises(ValueError):
                bootstrap.main()
            credential.chmod(0o644)
            with self.assertRaises(ValueError):
                bootstrap.main()
        self.assertFalse(any(call[0] in ("useradd", "install", "runuser", "systemctl") for call in self.trace))

    def test_creates_account_and_clones_only_as_service_user(self):
        with patch.object(bootstrap.pwd, "getpwnam", side_effect=KeyError), patch.object(
                bootstrap, "run", self.fake_run):
            bootstrap.prepare_repository()
        self.assertTrue(any(call[0] == "useradd" for call in self.trace))
        self.assertIn(("runuser", "-u", "imajin", "--", "git", "clone", "--bare",
                       "https://github.com/ima-jin/imajin-ai.git", str(self.state / "repo")), self.trace)
        self.assertFalse(any(call[0] in ("git", "pnpm") for call in self.trace))

    def test_existing_account_and_repo_are_retained_and_symlinked_state_is_refused(self):
        repo = self.state / "repo"
        repo.mkdir()
        with patch.object(bootstrap.pwd, "getpwnam"), patch.object(bootstrap, "run", self.fake_run):
            bootstrap.prepare_repository()
            self.assertFalse(any(call[0] in ("useradd", "runuser") for call in self.trace))
            repo.rmdir()
            repo.symlink_to(self.source)
            with self.assertRaises(ValueError):
                bootstrap.prepare_repository()


if __name__ == "__main__":
    unittest.main()
