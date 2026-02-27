#!/usr/bin/env python3
"""
task-update-bridge.py — Drop-in replacement for task_update.py that routes
status updates to the taskcore daemon HTTP API.

Same CLI interface as the original:
    python3 task-update-bridge.py --task-id N --status S [--evidence E] [--blocker B]

Environment:
    ORCHESTRATOR_PORT  (default 18800)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

PORT = int(os.environ.get("ORCHESTRATOR_PORT", "18800"))
BASE = f"http://127.0.0.1:{PORT}"

STATUS_MAP = {
    "pending": "pending",
    "in_progress": "pending",     # Return to work = changes_requested
    "in-progress": "pending",
    "changes_requested": "pending",
    "changes-requested": "pending",
    "review": "review",
    "blocked": "blocked",
    "done": "done",
}


def post(path: str, body: dict) -> dict:
    url = f"{BASE}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body_text)
        except json.JSONDecodeError:
            return {"error": f"HTTP {e.code}", "message": body_text}


def main():
    parser = argparse.ArgumentParser(
        description="Update task status via taskcore daemon"
    )
    parser.add_argument("--task-id", required=True, type=str, help="Task ID")
    parser.add_argument(
        "--status",
        required=True,
        choices=[
            "pending", "in_progress", "in-progress",
            "changes_requested", "changes-requested",
            "review", "blocked", "done",
        ],
        help="New status",
    )
    parser.add_argument("--evidence", default=None, help="Evidence / notes")
    parser.add_argument("--blocker", default=None, help="Blocker description")
    parser.add_argument("--comment", default=None, help="Additional comment")
    parser.add_argument("--next", default=None, help="Next steps (appended to evidence)")

    args = parser.parse_args()

    # Normalize status
    mapped = STATUS_MAP.get(args.status)
    if mapped is None:
        print(json.dumps({"error": f"Unknown status: {args.status}"}))
        sys.exit(1)

    # Build evidence string
    evidence_parts = []
    if args.evidence:
        evidence_parts.append(args.evidence)
    if args.comment:
        evidence_parts.append(f"Comment: {args.comment}")
    if args.next:
        evidence_parts.append(f"Next: {args.next}")
    evidence = "\n".join(evidence_parts) if evidence_parts else None

    # Build request body
    body = {"status": mapped}
    if evidence:
        body["evidence"] = evidence
    if args.blocker:
        body["blocker"] = args.blocker

    result = post(f"/tasks/{args.task_id}/status", body)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
