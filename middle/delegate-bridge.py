#!/usr/bin/env python3
"""
delegate-bridge.py — Drop-in replacement for delegate.py that creates tasks
via the taskcore daemon HTTP API.

Same CLI interface as the original:
    python3 delegate-bridge.py --title T --task D --reviewer R [--assignee A] [--priority P]

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

PRIORITY_CHOICES = ["backlog", "low", "medium", "high", "critical"]
AGENT_CHOICES = [
    "coder", "analyst", "coder-lite", "hermes", "ceo", "orchestrator",
]
REVIEWER_CHOICES = AGENT_CHOICES + ["kelvin", "arthur"]


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
        description="Create a task via taskcore daemon"
    )
    parser.add_argument("--title", required=True, help="Short task title")
    parser.add_argument("--task", required=True, help="Detailed task description")
    parser.add_argument(
        "--assignee",
        default=None,
        choices=AGENT_CHOICES,
        help="Agent to assign",
    )
    parser.add_argument(
        "--priority",
        default="medium",
        choices=PRIORITY_CHOICES,
        help="Task priority",
    )
    parser.add_argument(
        "--reviewer",
        required=True,
        choices=REVIEWER_CHOICES,
        help="Reviewer agent or role",
    )
    parser.add_argument(
        "--consulted",
        default=None,
        choices=["analyst", "hermes", "ceo"],
        help="Agent to consult if blocked",
    )
    parser.add_argument(
        "--parent-task-id",
        default=None,
        type=str,
        help="Parent task ID for linking",
    )
    parser.add_argument(
        "--informed",
        default=None,
        nargs="*",
        help="Notification targets (telegram:id, session, etc.)",
    )

    args = parser.parse_args()

    body = {
        "title": args.title,
        "description": args.task,
        "priority": args.priority,
        "reviewer": args.reviewer,
    }

    if args.assignee:
        body["assignee"] = args.assignee
    if args.consulted:
        body["consulted"] = args.consulted
    if args.parent_task_id:
        body["parentId"] = args.parent_task_id
    if args.informed:
        body["informed"] = args.informed

    result = post("/tasks", body)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
