#!/usr/bin/env python3
"""Trusted installer, not an entry point for arbitrary paths or commands."""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

STATE = Path("/var/lib/imajin/infer-passthrough")
BUNDLE = Path("/usr/local/libexec/infer-passthrough")
ETC = Path("/etc/imajin")
UNITS = Path("/etc/systemd/system")
SERVICE = "infer-passthrough.service"
SYSTEMCTL = "systemctl"
TIMER = "infer-passthrough-update.timer"
UPDATER = "infer-passthrough-update.service"
COMPLETE = "bootstrap-complete"
CURRENT = "current"
RELEASES = "releases"
RUNTIME_USER = "imajin"
VALUE_ARG = "--value"
NOW_ARG = "--now"
ENV = "infer-passthrough.env"
ROUTES = "INFER_PROXY_ROUTES_CONFIG"
UNIT_NAMES = (SERVICE, UPDATER, TIMER)


def run(*args):
    # systemctl's Environment property can contain credentials. Capture it in
    # memory only; never forward subprocess output or errors to the journal.
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def trusted(path):
    """Every ancestor must be root-owned and non-writable by other users."""
    for item in (path, *path.parents):
        mode = item.lstat()
        if stat.S_ISLNK(mode.st_mode) or mode.st_uid != 0 or mode.st_mode & 0o022:
            raise ValueError("Untrusted bootstrap path")


def assignments(text):
    result = {}
    for entry in shlex.split(text, comments=False):
        key, separator, value = entry.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key):
            raise ValueError("Invalid environment assignment")
        result[key] = value
    return result


def migrated_environment(inline, existing):
    """EnvironmentFile wins over Environment, matching systemd precedence."""
    merged = assignments(inline)
    # Refuse unsupported multiline syntax rather than silently changing a key.
    for line in existing.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", ";")):
            continue
        key, separator, value = line.partition("=")
        if not separator or value.rstrip().endswith("\\"):
            raise ValueError("Unsupported environment file")
        parsed = assignments(f"{key}={value}")
        if len(parsed) != 1:
            raise ValueError("Unsupported environment file")
        merged.update(parsed)
    route = merged.pop(ROUTES, None)
    # Never import a repository credential into an app's environment.
    if any(key in merged for key in ("GH_TOKEN", "GITHUB_TOKEN", "INFER_UPDATE_GITHUB_TOKEN")):
        raise ValueError("Repository credentials cannot enter an environment file")
    def quote(value):
        if "\x00" in value or "\n" in value or "\r" in value:
            raise ValueError("Unsupported environment value")
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return "".join(f"{key}={quote(value)}\n" for key, value in sorted(merged.items())), route


def seed_current(source, state):
    version = json.loads((source / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Invalid running version")
    # Stage outside the service-writable releases directory. Root never walks
    # a tree an unprivileged process can rename or replace during copying.
    staging = Path(tempfile.mkdtemp(prefix=f"initial-v{version}-", dir=state))
    initial = state / RELEASES / staging.name
    # Carry installed dependencies, not home-directory secrets or git metadata.
    shutil.copytree(source, staging, symlinks=True, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", ".env*", "*.log", ".npmrc", ".netrc", ".ssh"))
    for directory, dirs, files in os.walk(staging):
        Path(directory).chmod(0o755)
        for name in dirs + files:
            item = Path(directory) / name
            if not item.is_symlink():
                item.chmod(0o755 if item.is_dir() or item.stat().st_mode & 0o111 else 0o644)
    staging.rename(initial)
    if (state / CURRENT).is_symlink():
        (state / CURRENT).unlink()
    (state / CURRENT).symlink_to(initial)
    return initial


def backup_files(backup):
    paths = [ETC / ENV, ETC / "infer-passthrough-update.env"]
    for name in UNIT_NAMES:
        paths.extend((UNITS / name, UNITS / f"{name}.d"))
    saved = []
    for index, path in enumerate(paths):
        destination = backup / str(index)
        if path.is_symlink():
            raise ValueError("Symlinked configuration is not supported")
        if path.is_dir():
            shutil.copytree(path, destination)
        elif path.exists():
            shutil.copy2(path, destination)
        saved.append((path, destination))
    return saved


def restore_files(saved):
    for path, backup in saved:
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        if backup.is_dir():
            shutil.copytree(backup, path)
        elif backup.exists():
            shutil.copy2(backup, path)


def migration_config():
    env_path = ETC / ENV
    inline = run(SYSTEMCTL, "show", SERVICE, "--property=Environment", VALUE_ARG)
    content, route = migrated_environment(inline, env_path.read_text())
    # Extra EnvironmentFiles could override the migrated file; refuse them.
    files = run(SYSTEMCTL, "show", SERVICE, "--property=EnvironmentFiles", VALUE_ARG)
    if files != f"{env_path} (ignore_errors=no)":
        raise ValueError("Unexpected service EnvironmentFiles")
    route_path = Path(route) if route else ETC / "routes.prod.json"
    if route_path.parent != ETC or route_path.is_symlink():
        raise ValueError("Routes file must be directly under /etc/imajin")
    source = Path(run(SYSTEMCTL, "show", SERVICE, "--property=WorkingDirectory", VALUE_ARG))
    if not source.is_absolute() or not source.is_dir():
        raise ValueError("Running checkout is unavailable")
    port = assignments(content).get("INFER_PROXY_PORT", "8787")
    if not re.fullmatch(r"[1-9]\d{0,4}", port) or int(port) > 65535 or port == "8788":
        raise ValueError("Invalid or colliding service port")
    return env_path, content, route_path, source, port


def install_units(backup):
    for name in UNIT_NAMES:
        dropins = UNITS / f"{name}.d"
        if dropins.exists():
            shutil.move(dropins, backup / f"{name}.d")
        shutil.copyfile(BUNDLE / name, UNITS / name)
        (UNITS / name).chmod(0o644)


def rollback(saved, backup, route_path, previous, timer_active, moved_route, invocation):
    restore_files(saved)
    if moved_route:
        shutil.move(backup / "routes", route_path)
    if previous is not None:
        temporary = STATE / "current.rollback"
        temporary.symlink_to(previous)
        temporary.replace(STATE / CURRENT)
    elif (STATE / CURRENT).is_symlink():
        (STATE / CURRENT).unlink()
    if not timer_active:
        run(SYSTEMCTL, "disable", NOW_ARG, TIMER)
    run(SYSTEMCTL, "daemon-reload")
    if run(SYSTEMCTL, "show", SERVICE, "--property=InvocationID", VALUE_ARG) != invocation:
        run(SYSTEMCTL, "restart", SERVICE)
    run(SYSTEMCTL, "is-active", "--quiet", SERVICE)
    if timer_active:
        run(SYSTEMCTL, "start", TIMER)


def migrate():
    env_path, content, route_path, source, port = migration_config()
    invocation = run(SYSTEMCTL, "show", SERVICE, "--property=InvocationID", VALUE_ARG)
    if not re.fullmatch(r"[a-f0-9]{32}", invocation):
        raise ValueError("Running service invocation is unavailable")
    backup = Path(tempfile.mkdtemp(prefix="bootstrap-", dir=STATE))
    backup.chmod(0o700)
    saved = backup_files(backup)
    previous = (STATE / CURRENT).resolve() if (STATE / CURRENT).is_symlink() else None
    timer_active = subprocess.run([SYSTEMCTL, "is-active", "--quiet", TIMER],
                                  capture_output=True).returncode == 0
    moved_route = False
    try:
        run(SYSTEMCTL, "stop", TIMER)
        seed_current(source, STATE)
        env_path.write_text(content)
        env_path.chmod(0o600)
        if route_path.exists():
            shutil.move(route_path, backup / "routes")
            moved_route = True
        install_units(backup)
        (ETC / "infer-passthrough-update.env").write_text(f"INFER_UPDATE_PORT={port}\n")
        run(SYSTEMCTL, "daemon-reload")
        # Reuse exactly the updater's candidate health, promotion and rollback.
        run(SYSTEMCTL, "start", UPDATER)
        run(SYSTEMCTL, "enable", SERVICE)
        run(SYSTEMCTL, "enable", NOW_ARG, TIMER)
        (STATE / COMPLETE).write_text("1\n")
    except BaseException:
        rollback(saved, backup, route_path, previous, timer_active, moved_route, invocation)
        raise


def prerequisites():
    trusted(BUNDLE)
    for name in (*UNIT_NAMES, "bootstrap.sh", "bootstrap.py", "update.sh",
                 "check-health.mjs", "production-deployment.mjs", "release.sha"):
        trusted(BUNDLE / name)
    # TODO #3190 (parent #3039): kernel vault/seal must provision this credential. No manual
    # token input, environment fallback, or copy-from-Actions workaround.
    credential = ETC / "infer-passthrough-github-token"
    trusted(credential)
    if stat.S_IMODE(credential.stat().st_mode) != 0o600 or credential.stat().st_size == 0:
        raise ValueError("Kernel-provisioned deployment credential required")
    for command in ("node", "pnpm", "git", SYSTEMCTL, "systemd-run", "runuser", "flock"):
        if shutil.which(command) is None:
            raise ValueError("Missing bootstrap prerequisite")
    if run("node", "--version").split(".")[0] not in ("v22", "v24") or not run("pnpm", "--version").startswith("9."):
        raise ValueError("Node 22/24 and pnpm 9 are required")
    sha = (BUNDLE / "release.sha").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid trusted bundle SHA")
    run("node", str(BUNDLE / "production-deployment.mjs"), sha)


def prepare_repository():
    try:
        pwd.getpwnam(RUNTIME_USER)
    except KeyError:
        run("useradd", "--system", "--user-group", "--home-dir", str(STATE / "home"),
            "--create-home", "--shell", "/usr/sbin/nologin", RUNTIME_USER)
    for name in (RELEASES, "repo"):
        if (STATE / name).is_symlink():
            raise ValueError("Symlinked state subdirectory")
    run("install", "-d", "-o", RUNTIME_USER, "-g", RUNTIME_USER, "-m", "0755", str(STATE / RELEASES))
    if not (STATE / "repo").exists():
        run("install", "-d", "-o", RUNTIME_USER, "-g", RUNTIME_USER, "-m", "0755", str(STATE / "repo"))
        run("runuser", "-u", RUNTIME_USER, "--", "git", "clone", "--bare",
            "https://github.com/ima-jin/imajin-ai.git", str(STATE / "repo"))


def completed():
    if not STATE.exists():
        return False
    trusted(STATE)
    if not (STATE / COMPLETE).exists():
        return False
    trusted(STATE / COMPLETE)
    return True


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError("Bootstrap requires root and no arguments")
    if completed():
        return
    prerequisites()
    STATE.parent.mkdir(parents=True, exist_ok=True)
    trusted(STATE.parent)
    STATE.parent.chmod(0o755)
    STATE.mkdir(parents=True, exist_ok=True)
    trusted(STATE)
    STATE.chmod(0o755)
    with (STATE / "update.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (STATE / "bootstrap-complete").exists():
            return
        prepare_repository()
        # Release the updater lock: bootstrap has its own fixed systemd unit,
        # and the updater must acquire this lock during promotion.
        fcntl.flock(lock, fcntl.LOCK_UN)
        migrate()


if __name__ == "__main__":
    try:
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
        main()
    except BaseException:
        print("infer-passthrough bootstrap failed; inspect prerequisites and rollback state (no credential details logged)", file=sys.stderr)
        sys.exit(1)
