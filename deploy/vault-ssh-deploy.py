"""No dependencies, credential outputs, shell evaluation, or disk fallback."""
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

AUDIENCE = "urn:imajin:vault:ssh-cert"
# The action selects the RAM mount explicitly, never a generic temp resolver.
# mkdtemp creates an exclusive random owner-only child under the verified mount.
ROOT = Path(os.environ["VAULT_SSH_MEMORY_ROOT"])


def require(condition):
    if not condition:
        raise ValueError("Invalid vault SSH configuration")


def check_memory():
    require(sys.platform == "linux")
    require(ROOT.is_absolute())
    result = subprocess.run(["stat", "-f", "-c", "%T", str(ROOT)],
                            check=True, capture_output=True, text=True)
    require(result.stdout.strip() == "tmpfs")
    # tmpfs may otherwise be paged to disk. Dedicated/container runners must disable swap.
    require(len(Path("/proc/swaps").read_text().splitlines()) <= 1)


def directory():
    path = Path(os.environ["VAULT_SSH_DIR"])
    require(path.parent == ROOT and re.fullmatch(r"vault-ssh-[a-z0-9_]+", path.name))
    require(not path.is_symlink())
    if path.exists():
        require(path.is_dir() and path.stat().st_uid == os.getuid())
        require(path.stat().st_mode & 0o777 == 0o700)
    return path


def cleanup():
    if os.environ.get("VAULT_SSH_DIR"):
        path = directory()
        if path.exists():
            shutil.rmtree(path)


def prepare():
    check_memory()
    path = tempfile.mkdtemp(prefix="vault-ssh-", dir=ROOT)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"directory={path}\n")  # only a path, never credential bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect refused")


def request_json(url, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        raw = response.read(65537)
        require(len(raw) <= 65536)
        return json.loads(raw)


def configuration():
    env = os.environ
    kernel = urllib.parse.urlsplit(env["VAULT_KERNEL_URL"])
    require(kernel.scheme == "https" and kernel.hostname and not kernel.username
            and not kernel.password and not kernel.query and not kernel.fragment)
    require(re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", env["VAULT_HOST"])
            and len(env["VAULT_HOST"]) <= 253)
    require(re.fullmatch(r"[a-z_][a-z0-9_-]{0,63}", env["VAULT_PRINCIPAL"]))
    require(re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", env["VAULT_PURPOSE"]))
    require(re.fullmatch(r"vmk_[a-zA-Z0-9_-]{1,100}", env["VAULT_CA_ID"]))
    require(re.fullmatch(r"vdg_[a-zA-Z0-9_-]{1,100}", env["VAULT_GRANT_ID"]))
    require(env["VAULT_TTL"].isdigit() and 1 <= int(env["VAULT_TTL"]) <= 900)
    require(env["VAULT_COMMAND"].strip() and "\0" not in env["VAULT_COMMAND"])
    require(env["VAULT_KNOWN_HOSTS"].strip() and len(env["VAULT_KNOWN_HOSTS"]) <= 65536)
    oidc = urllib.parse.urlsplit(env["ACTIONS_ID_TOKEN_REQUEST_URL"])
    require(oidc.scheme == "https" and oidc.hostname
            and oidc.hostname.endswith(".actions.githubusercontent.com")
            and not oidc.username and not oidc.password and not oidc.fragment)
    require(env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"])
    query = urllib.parse.parse_qsl(oidc.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "audience"]
    query.append(("audience", AUDIENCE))
    return env["VAULT_KERNEL_URL"].rstrip("/"), oidc._replace(query=urllib.parse.urlencode(query)).geturl()


def deploy():
    check_memory()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    path = directory()
    require(path.exists())
    kernel, oidc_url = configuration()
    env = os.environ
    key = path / "identity"
    # Neither subprocess arguments nor environment contain the generated private key.
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "",
                    "-f", str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token = request_json(oidc_url, {
        "Authorization": f"Bearer {env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}",
    })["value"]
    require(isinstance(token, str) and 0 < len(token) <= 16384)
    signed = request_json(f"{kernel}/api/vault/ssh-ca/sign", {
        "x-github-oidc-token": token, "Content-Type": "application/json",
    }, {
        "purpose": env["VAULT_PURPOSE"], "caId": env["VAULT_CA_ID"],
        "grantId": env["VAULT_GRANT_ID"], "publicKey": (path / "identity.pub").read_text().strip(),
        "host": env["VAULT_HOST"], "principal": env["VAULT_PRINCIPAL"], "ttl": int(env["VAULT_TTL"]),
    })
    certificate = signed["certificate"]
    require(isinstance(certificate, str)
            and re.fullmatch(r"ssh-ed25519-cert-v01@openssh.com [A-Za-z0-9+/=]+(?: [^\r\n]*)?", certificate))
    cert = path / "identity-cert.pub"
    cert.write_text(certificate + "\n")
    known = path / "known_hosts"
    known.write_text(env["VAULT_KNOWN_HOSTS"] + "\n")
    # Ignore user/system SSH config and agents. Host authenticity is independently pinned.
    return subprocess.run([
        "ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known}",
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
        "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
        "-o", "ConnectTimeout=30", "-o", f"CertificateFile={cert}", "-i", str(key),
        "--", f"{env['VAULT_PRINCIPAL']}@{env['VAULT_HOST']}", env["VAULT_COMMAND"],
    ], check=False).returncode


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def main():
    os.umask(0o077)
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    mode = sys.argv[1]
    try:
        if mode == "prepare":
            prepare()
            return 0
        if mode == "cleanup":
            cleanup()
            return 0
        require(mode == "deploy")
        try:
            return deploy()
        finally:
            cleanup()
    except (Exception, KeyboardInterrupt):
        # Never stringify HTTP bodies, tokens, subprocess errors or request objects.
        print("Vault SSH step failed; credentials discarded.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
