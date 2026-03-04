#!/bin/bash
set -euo pipefail

# Setup OS-level protection for the taskcore append-only event log.
#
# Usage:
#   sudo ./setup-eventlog.sh [event-log-dir]
#
# Default dir: $HOME/.openclaw/workspace/data/taskcore
#
# What this does:
#   1. Creates directory structure (events.jsonl, snapshots/)
#   2. Sets file permissions (owner read/write only)
#   3. Sets kernel-level append-only flag (chattr +a) on events.jsonl
#
# After running this script:
#   - events.jsonl can ONLY be appended to (not truncated, overwritten, or deleted)
#   - Only chattr -a (requires root/CAP_LINUX_IMMUTABLE) can remove the protection
#   - Snapshots remain normal files (they're disposable materialized views)

EVENTLOG_DIR="${1:-${HOME}/.openclaw/workspace/data/taskcore}"
EVENTLOG="$EVENTLOG_DIR/events.jsonl"

echo "[setup] Event log directory: $EVENTLOG_DIR"

# Create directory structure
mkdir -p "$EVENTLOG_DIR/snapshots"

# Create event log if it doesn't exist
touch "$EVENTLOG"

# File permissions: owner read/write only
chmod 600 "$EVENTLOG"
chmod 700 "$EVENTLOG_DIR"
chmod 700 "$EVENTLOG_DIR/snapshots"

echo "[setup] Permissions set (600 on events.jsonl, 700 on dirs)"

# Kernel-level append-only flag
# After this, NO process (not even root) can:
#   - truncate the file
#   - overwrite existing content
#   - delete the file
#   - rename the file
# Only appends are allowed.
if command -v chattr &>/dev/null; then
  sudo chattr +a "$EVENTLOG"
  echo "[setup] chattr +a set on events.jsonl"
  lsattr "$EVENTLOG"
else
  echo "[setup] WARNING: chattr not found. Skipping append-only flag."
  echo "[setup]   Install e2fsprogs to enable kernel-level protection."
fi

echo ""
echo "[setup] Event log protected:"
ls -la "$EVENTLOG"
echo ""
echo "[setup] Done. The event log is now append-only at the kernel level."
echo "[setup] To remove protection (for migration/maintenance):"
echo "[setup]   sudo chattr -a $EVENTLOG"
