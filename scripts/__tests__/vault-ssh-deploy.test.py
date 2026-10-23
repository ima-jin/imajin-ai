"""Exercise the runner with real tmpfs key generation and mocked network/SSH."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("vault_ssh", "deploy/vault-ssh-deploy.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "VAULT_KERNEL_URL": "https://kernel.example.com", "VAULT_PURPOSE": "deploy",
            "VAULT_CA_ID": "vmk_test", "VAULT_GRANT_ID": "vdg_test", "VAULT_HOST": "host.example.com",
            "VAULT_PRINCIPAL": "deploy", "VAULT_COMMAND": "/usr/local/bin/deploy",
            "VAULT_KNOWN_HOSTS": "host.example.com ssh-ed25519 public-fixture", "VAULT_TTL": "600",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/job?id=1",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": uuid.uuid4().hex,
        }
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.output = tempfile.NamedTemporaryFile(mode="w+", delete=True)
        self.addCleanup(self.output.close)
        os.environ["GITHUB_OUTPUT"] = self.output.name
        runner.prepare()
        self.path = Path(Path(self.output.name).read_text().strip().split("=", 1)[1])
        os.environ["VAULT_SSH_DIR"] = str(self.path)
        self.addCleanup(runner.cleanup)
        self.token = uuid.uuid4().hex

    def response(self, url, headers, body=None):
        if body is None:
            self.assertEqual(headers["Authorization"], f"Bearer {self.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}")
            self.assertIn("audience=urn%3Aimajin%3Avault%3Assh-cert", url)
            return {"value": self.token}
        self.assertEqual(url, "https://kernel.example.com/api/vault/ssh-ca/sign")
        self.assertEqual(headers["x-github-oidc-token"], self.token)
        self.assertEqual(set(body), {"purpose", "caId", "grantId", "publicKey", "host", "principal", "ttl"})
        self.assertTrue(body["publicKey"].startswith("ssh-ed25519 "))
        self.assertEqual((self.path / "identity").stat().st_mode & 0o777, 0o600)
        # Test boolean only: never print generated key bytes even on assertion failure.
        self.assertTrue((self.path / "identity").read_bytes().startswith(b"-----BEGIN OPENSSH PRIVATE KEY-----"))
        return {"certificate": "ssh-ed25519-cert-v01@openssh.com AAAA"}

    def invoke(self):
        with patch.object(sys, "argv", ["runner", "deploy"]):
            return runner.main()

    def test_success_and_remote_failure_discard_real_key_and_certificate(self):
        real_run = subprocess.run
        for exit_code in [0, 23]:
            if not self.path.exists():
                self.path.mkdir(mode=0o700)

            def execute(args, **kwargs):
                if args[0] != "ssh":
                    return real_run(args, **kwargs)
                self.assertTrue((self.path / "identity-cert.pub").exists())
                self.assertIn("StrictHostKeyChecking=yes", args)
                self.assertIn("IdentityAgent=none", args)
                self.assertIn("ClearAllForwardings=yes", args)
                self.assertEqual(args[1:3], ["-F", "/dev/null"])
                self.assertEqual(args[-2:], ["deploy@host.example.com", "/usr/local/bin/deploy"])
                self.assertNotIn("shell", kwargs)
                self.assertNotIn(self.token, str(args))
                return subprocess.CompletedProcess(args, exit_code)

            with patch.object(runner, "request_json", side_effect=self.response), \
                    patch.object(runner.subprocess, "run", side_effect=execute):
                self.assertEqual(self.invoke(), exit_code)
            self.assertFalse(self.path.exists())

    def test_signing_failure_and_signal_discard_credentials_without_error_details(self):
        for failure in [RuntimeError("unsafe-response-must-not-print"), KeyboardInterrupt()]:
            if not self.path.exists():
                self.path.mkdir(mode=0o700)
            with patch.object(runner, "request_json", side_effect=failure), \
                    patch("sys.stderr") as stderr:
                self.assertEqual(self.invoke(), 1)
                self.assertNotIn("unsafe-response", str(stderr.write.call_args_list))
            self.assertFalse(self.path.exists())
        with self.assertRaises(KeyboardInterrupt):
            runner.interrupted(signal.SIGTERM, None)

    def test_no_disk_fallback_no_swap_and_no_symlink_cleanup(self):
        with patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="ext4")):
            with self.assertRaises(ValueError):
                runner.check_memory()
        with patch.object(Path, "read_text", return_value="Filename\n/swapfile"):
            with self.assertRaises(ValueError):
                runner.check_memory()
        with patch.dict(os.environ, {"VAULT_SSH_DIR": "/tmp/vault-ssh-test"}):
            with self.assertRaises(ValueError):
                runner.cleanup()
        link = self.path.parent / f"vault-ssh-{uuid.uuid4().hex}"
        link.symlink_to(self.path)
        try:
            with patch.dict(os.environ, {"VAULT_SSH_DIR": str(link)}):
                with self.assertRaises(ValueError):
                    runner.cleanup()
        finally:
            link.unlink()
        self.path.chmod(0o755)
        with self.assertRaises(ValueError):
            runner.directory()
        self.path.chmod(0o700)
        with patch.object(os, "getuid", return_value=-1):
            with self.assertRaises(ValueError):
                runner.directory()
        runner.cleanup()
        runner.cleanup()  # always() cleanup is idempotent

    def test_invalid_input_fails_before_generating_key(self):
        invalid = {
            "VAULT_KERNEL_URL": ["http://kernel.test", "https://user@kernel.test", "https://kernel.test?q=1",
                                 "https://kernel.test#fragment", "not-url"],
            "VAULT_HOST": ["-oProxyCommand=x", "*.example.com", "x" * 254, ""],
            "VAULT_PRINCIPAL": ["root;id", "-root", ""],
            "VAULT_PURPOSE": ["BAD", ""], "VAULT_CA_ID": ["wrong"], "VAULT_GRANT_ID": ["wrong"],
            "VAULT_TTL": ["0", "901", "1.5", "n/a"], "VAULT_COMMAND": ["", " "],
            "VAULT_KNOWN_HOSTS": ["", "x" * 65537],
            "ACTIONS_ID_TOKEN_REQUEST_URL": ["http://pipelines.actions.githubusercontent.com",
                                            "https://attacker.invalid", "https://a.actions.githubusercontent.com.evil",
                                            "https://user@a.actions.githubusercontent.com",
                                            "https://a.actions.githubusercontent.com#fragment"],
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": [""],
        }
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key), patch.dict(os.environ, {key: value}), \
                        patch.object(runner.subprocess, "run") as execute:
                    with self.assertRaises(ValueError):
                        runner.configuration()
                    execute.assert_not_called()

    def test_redirects_and_oversized_http_responses_are_refused(self):
        with self.assertRaises(ValueError):
            runner.NoRedirect().redirect_request(None, None, 302, "", {}, "https://attacker.invalid")
        with patch.object(runner.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b"x" * 65537
            with self.assertRaises(ValueError):
                runner.request_json("https://kernel.test", {})

    def test_invalid_certificate_and_oidc_response_discard_credentials(self):
        for response in [{"value": ""}, {"value": 1}, {"value": "x" * 16385},
                         {"certificate": "not-a-certificate"}, {"certificate": 1}]:
            if not self.path.exists():
                self.path.mkdir(mode=0o700)

            def respond(url, headers, body=None):
                if body is None and "certificate" in response:
                    return {"value": self.token}
                return response

            with patch.object(runner, "request_json", side_effect=respond), patch("sys.stderr"):
                self.assertEqual(self.invoke(), 1)
            self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
