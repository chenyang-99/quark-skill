#!/usr/bin/env python3
"""Agent-side GitHub Actions client. The Quark runtime stays on GitHub."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid


def gh(*args, body=None):
    result = subprocess.run(["gh", *args], input=body, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("GitHub command failed. Check authentication and Actions permissions.")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["authorize-start", "authorize-finish", "read"])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--keyword")
    parser.add_argument("--max-files", type=int, default=5)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.operation == "read" and (not args.keyword or not 1 <= args.max_files <= 20):
        parser.error("read requires --keyword and --max-files between 1 and 20")
    request_id = str(uuid.uuid4())
    workflow = "read-markdown.yml" if args.operation == "read" else "authorize.yml"
    inputs = {"request_id": request_id}
    prefix = "quark-md:" if args.operation == "read" else "quark-auth:"
    artifact = "quark-markdown-" if args.operation == "read" else "quark-auth-"
    if args.operation == "read":
        inputs.update(keyword=args.keyword, max_files=str(args.max_files))
    else:
        inputs["action"] = "start" if args.operation == "authorize-start" else "finish"
    metadata = json.loads(gh("api", f"repos/{args.repo}"))
    response = gh("api", "--method", "POST", "-H", "X-GitHub-Api-Version: 2026-03-10",
                  f"repos/{args.repo}/actions/workflows/{workflow}/dispatches", "--input", "-",
                  body=json.dumps({"ref": metadata["default_branch"], "inputs": inputs}))
    data = json.loads(response) if response.strip() else {}
    run_id = data.get("workflow_run_id")
    # Older GitHub API/CLI versions return no dispatch run ID.
    for _ in range(12):
        if run_id:
            break
        runs = json.loads(gh("api", f"repos/{args.repo}/actions/workflows/{workflow}/runs?event=workflow_dispatch&per_page=100"))
        run_id = next((run["id"] for run in runs["workflow_runs"]
                       if run.get("display_title") == prefix + request_id), None)
        if not run_id:
            time.sleep(5)
    if not run_id:
        raise RuntimeError(f"Workflow dispatched but run not located. Request: {request_id}")
    print(json.dumps({"run_id": run_id, "request_id": request_id,
                      "url": f"https://github.com/{args.repo}/actions/runs/{run_id}"}), flush=True)
    watched = subprocess.run(["gh", "run", "watch", str(run_id), "--repo", args.repo, "--exit-status", "--interval", "5"])
    args.output.mkdir(parents=True, exist_ok=True)
    # Failure manifests are useful too, but never report a failed run as success.
    try:
        gh("run", "download", str(run_id), "--repo", args.repo, "--name", artifact + request_id,
           "--dir", str(args.output))
    except RuntimeError:
        if not watched.returncode:
            raise
    if watched.returncode:
        raise RuntimeError(f"Workflow failed. Inspect the run and any manifest in {args.output}.")
    print(f"Result directory: {args.output}", flush=True)


if __name__ == "__main__":
    main()
