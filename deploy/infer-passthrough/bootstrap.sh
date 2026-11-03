#!/usr/bin/env bash
# Installed root-owned alongside the reviewed helpers; never sudo a checkout.
set -euo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $# == 0 && $EUID == 0 ]] || { printf 'Bootstrap requires root and no arguments\n' >&2; exit 2; }
exec /usr/bin/python3 /usr/local/libexec/infer-passthrough/bootstrap.py
