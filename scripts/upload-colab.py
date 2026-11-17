# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "google-api-python-client>=2,<3",
#   "google-auth-httplib2>=0.2,<1",
#   "google-auth-oauthlib>=1.2,<2",
# ]
# ///
"""Upload a notebook to Google Drive and print its Colab editor URL."""

import argparse
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
MIME_TYPE = "application/x-ipynb+json"


def describe_drive_error(error):
    """Report structured API reasons without exposing request headers or tokens."""
    try:
        payload = json.loads(error.content).get("error", {})
        entries = [*payload.get("errors", []), *payload.get("details", [])]
        reasons = sorted({
            entry["reason"] for entry in entries
            if isinstance(entry, dict)
            and isinstance(entry.get("reason"), str)
            and re.fullmatch(r"[A-Za-z0-9_.-]+", entry["reason"])
        })
    except (ValueError, TypeError, AttributeError):
        reasons = []
    reason_text = ", ".join(reasons) or "unspecified"
    hints = []
    if set(reasons) & {"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}:
        hints.append("Run 'gcloud auth login --enable-gdrive-access --force' and grant Drive access, or use the custom desktop OAuth setup.")
    if set(reasons) & {"accessNotConfigured", "SERVICE_DISABLED"}:
        hints.append("Enable drive.googleapis.com in the quota project and wait a few minutes for propagation.")
    if set(reasons) & {"USER_PROJECT_DENIED", "CONSUMER_INVALID"}:
        hints.append("Check the project ID and that the active account can use services in that project.")
    if "storageQuotaExceeded" in reasons:
        hints.append("Free space in the authenticated account's Google Drive.")
    if "domainPolicy" in reasons:
        hints.append("Your Workspace administrator must permit this Drive API access.")
    if not hints:
        hints.append("Check Drive API enablement, account permissions, and quotas. See Google's Drive API error guide.")
    return f"Drive upload failed (HTTP {error.resp.status}; reason: {reason_text}). " + " ".join(hints)


def authenticate_gcloud(project):
    from google.oauth2.credentials import Credentials

    gcloud = shutil.which("gcloud")
    if not gcloud:
        raise RuntimeError("Google Cloud CLI is not on PATH. Run scripts/setup-colab.py for setup instructions.")
    result = subprocess.run(
        [gcloud, "auth", "print-access-token"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    # Never print token-command output or include it in exception messages.
    token = result.stdout.strip()
    if result.returncode != 0 or not token or any(char.isspace() for char in token):
        raise RuntimeError(
            "Could not obtain a gcloud access token. Run "
            "'gcloud auth login --enable-gdrive-access --force' and retry."
        )
    return Credentials(token=token, quota_project_id=project)


def prepare_notebook(filename):
    notebook = json.loads(filename.read_text(encoding="utf-8"))
    if not isinstance(notebook, dict) or notebook.get("nbformat") != 4:
        raise ValueError("Expected a version 4 Jupyter notebook.")
    if not isinstance(notebook.get("cells"), list):
        raise ValueError("Notebook must contain a cells list.")
    for cell in notebook["cells"]:
        if not isinstance(cell, dict):
            raise ValueError("Notebook cells must be objects.")
        if cell.get("cell_type") == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
    return notebook


def authenticate(client_secrets, token_file, reauth=False):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    credentials = None
    if token_file.exists() and not reauth:
        credentials = Credentials.from_authorized_user_file(str(token_file), SCOPES)
    if credentials and credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
    if not credentials or not credentials.valid:
        if not client_secrets.is_file():
            raise ValueError(
                f"Desktop OAuth client JSON not found: {client_secrets}. "
                "Follow the README's Colab API upload setup."
            )
        flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets), SCOPES)
        credentials = flow.run_local_server(
            port=0,
            prompt="select_account",
            timeout_seconds=300,
        )
    token_file.parent.mkdir(parents=True, exist_ok=True)
    # Restrict newly created token files on systems supporting POSIX modes.
    descriptor = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as token:
        token.write(credentials.to_json())
    return credentials


def upload_notebook(notebook, name, credentials):
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaIoBaseUpload

    data = io.BytesIO(json.dumps(notebook, indent=1).encode("utf-8"))
    media = MediaIoBaseUpload(data, mimetype=MIME_TYPE, resumable=False)
    service = build("drive", "v3", credentials=credentials, cache_discovery=False)
    try:
        return service.files().create(
            body={"name": name, "mimeType": MIME_TYPE},
            media_body=media,
            fields="id,name",
        ).execute()
    except HttpError as error:
        raise RuntimeError(describe_drive_error(error)) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notebook", type=Path, default=ROOT / "notebook/colab-browser.ipynb")
    parser.add_argument("--name", default="colab-browser.ipynb", help="New Drive file name")
    parser.add_argument("--client-secrets", type=Path, default=ROOT / ".colab-auth/client-secret.json")
    parser.add_argument("--token-file", type=Path, default=ROOT / ".colab-auth/token.json")
    parser.add_argument("--reauth", action="store_true", help="Choose a Google account again")
    parser.add_argument("--auth", choices=["oauth", "gcloud"], default="oauth", help="Authentication method (default: oauth desktop client)")
    parser.add_argument("--project", help="Google Cloud quota project ID (required for --auth gcloud)")
    parser.add_argument("--dry-run", action="store_true", help="Validate locally without Google sign-in or upload")
    args = parser.parse_args(argv)
    if not args.name.strip() or not args.name.endswith(".ipynb"):
        parser.error("--name must be a nonempty name ending in .ipynb")
    if args.auth == "gcloud":
        if not args.project or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args.project):
            parser.error("--auth gcloud requires --project with a valid Google Cloud project ID")
        if args.reauth:
            parser.error("For gcloud sign-in, use 'gcloud auth login --enable-gdrive-access --force' instead of --reauth")
    elif args.project:
        parser.error("--project is used with --auth gcloud")
    notebook = prepare_notebook(args.notebook)
    if args.dry_run:
        print(json.dumps({
            "dryRun": True,
            "source": str(args.notebook.resolve()),
            "name": args.name,
            "mimeType": MIME_TYPE,
            "cellCount": len(notebook["cells"]),
            "savedOutputsCleared": True,
            "auth": args.auth,
            "project": args.project,
            "scope": SCOPES[0] if args.auth == "oauth" else "Google Cloud and Drive access granted to gcloud",
        }, indent=2))
        return
    if args.auth == "gcloud":
        credentials = authenticate_gcloud(args.project)
    else:
        credentials = authenticate(args.client_secrets, args.token_file, args.reauth)
    uploaded = upload_notebook(notebook, args.name, credentials)
    print(f"Uploaded: {uploaded['name']}")
    print(f"Open in Colab: https://colab.research.google.com/drive/{uploaded['id']}")
    print("Upload complete. Select a T4 runtime and run the cells in Colab.")
    print("Each upload creates a new Drive file; no notebook is started or shared.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
    except ImportError:
        print("ERROR: Missing Google client libraries. Run: uv run scripts/upload-colab.py", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(
            f"ERROR: Google authentication or upload failed ({type(error).__name__}). "
            "Check your OAuth client configuration. Use --reauth to sign in again.",
            file=sys.stderr,
        )
        sys.exit(1)
