#!/usr/bin/env python3
"""Submit encrypted GitHub file requests. Quark runs entirely on GitHub."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent


def gh(*args, body=None, missing_ok=False):
    result = subprocess.run(["gh", *args], input=body, text=True, capture_output=True)
    if result.returncode:
        if missing_ok and "HTTP 404" in result.stderr:
            return None
        raise RuntimeError("GitHub operation failed. Check repository read/write access.")
    return result.stdout


def node(*args, body=None):
    result = subprocess.run(["node", str(ROOT / "crypto.cjs"), *map(str, args)],
                            input=body, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Encrypted transport failed; no private key or plaintext was published.")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["authorize-start", "authorize-finish", "read", "browse", "delivery-test"])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--keyword")
    parser.add_argument("--folder")
    parser.add_argument("--folder-fid")
    parser.add_argument("--max-files", type=int, default=5)
    parser.add_argument("--auth-code-file", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo):
        parser.error("--repo must be owner/name")
    if args.operation == "read" and (not args.keyword or not 1 <= len(args.keyword) <= 50 or not 1 <= args.max_files <= 20):
        parser.error("read requires a 1–50 character keyword and max-files of 1–20")
    if args.operation == "browse" and not (args.folder_fid or (args.folder and 1 <= len(args.folder) <= 50)):
        parser.error("browse requires a 1–50 character --folder name or a previously returned --folder-fid")
    if args.operation == "authorize-finish" and not args.auth_code_file:
        parser.error("authorize-finish requires a private --auth-code-file")
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("--output must be a fresh or empty directory")
    request_id = str(uuid.uuid4())
    branch = f"quark-requests/{request_id}"
    metadata = json.loads(gh("api", f"repos/{args.repo}"))
    head = json.loads(gh("api", f"repos/{args.repo}/git/ref/heads/{metadata['default_branch']}"))["object"]["sha"]
    with tempfile.TemporaryDirectory(prefix="quark-client-") as temporary:
        private_dir = Path(temporary)
        node("keygen", private_dir)
        request = {"request_id": request_id, "operation": args.operation,
                   "result_public_key": (private_dir / "result.public.pem").read_text()}
        if args.operation in ("read", "browse", "authorize-finish"):
            public = gh("api", f"repos/{args.repo}/contents/request-public-key.pem?ref=quark-state",
                        missing_ok=True)
            if public is None:
                raise RuntimeError("Initialize account binding with authorize-start after configuring QUARK_STATE_KEY.")
            receiver = private_dir / "receiver.pem"
            receiver.write_bytes(base64.b64decode(json.loads(public)["content"]))
            payload = {"operation": args.operation, "request_id": request_id}
            if args.operation == "read":
                payload.update(keyword=args.keyword, max_files=args.max_files)
            elif args.operation == "browse":
                payload.update(folder=args.folder, folder_fid=args.folder_fid)
            else:
                payload["auth_code"] = args.auth_code_file.read_text().strip()
            context = f"request:{args.repo}:{request_id}"
            request["encrypted_request"] = json.loads(node("request", receiver, context,
                                                           body=json.dumps(payload)))
        gh("api", "--method", "POST", f"repos/{args.repo}/git/refs", "--input", "-",
           body=json.dumps({"ref": f"refs/heads/{branch}", "sha": head}))
        gh("api", "--method", "PUT", f"repos/{args.repo}/contents/request.json", "--input", "-",
           body=json.dumps({"branch": branch, "message": "Submit encrypted Quark Agent request",
                            "content": base64.b64encode(json.dumps(request).encode()).decode()}))
        print(json.dumps({"request_id": request_id, "branch": branch,
                          "url": f"https://github.com/{args.repo}/tree/{branch}"}), flush=True)
        deadline = time.monotonic() + args.timeout
        response = None
        while time.monotonic() < deadline:
            raw = gh("api", "-H", "Accept: application/vnd.github.raw+json",
                     f"repos/{args.repo}/contents/response.json?ref={branch}", missing_ok=True)
            if raw is not None:
                response = json.loads(raw)
                break
            time.sleep(5)
        if response is None:
            raise RuntimeError(f"Timed out waiting for encrypted response. Request branch: {branch}")
        if response.get("request_id") != request_id:
            raise RuntimeError("Response request identifier mismatch.")
        encrypted = private_dir / "encrypted-result.json"
        encrypted.write_text(json.dumps(response["encrypted_result"]))
        node("decrypt", encrypted, args.output, private_dir / "result.private.pem",
             f"result:{args.repo}:{request_id}")
        # This branch was created by this invocation and contains ciphertext only.
        try:
            gh("api", "--method", "DELETE", f"repos/{args.repo}/git/refs/heads/{branch}")
        except RuntimeError:
            print("Request branch cleanup was unavailable; it contains only encrypted messages.", flush=True)
        print(json.dumps({"status": response["status"], "run_url": response["run_url"],
                          "result_directory": str(args.output)}), flush=True)
        if response["status"] != "complete":
            raise RuntimeError(f"Workflow failed. Read the failure manifest in {args.output}.")
        manifest = args.output / "manifest.json"
        if manifest.exists() and json.loads(manifest.read_text()).get("status") != "complete":
            raise RuntimeError("The decrypted manifest did not report a complete read.")


if __name__ == "__main__":
    main()
