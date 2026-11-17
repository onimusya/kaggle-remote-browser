# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Configure Google Drive uploads through gcloud without a custom OAuth client."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Google Cloud project ID (6–30 characters)")
    parser.add_argument("--create-project", action="store_true", help="Create this project before enabling Drive API")
    parser.add_argument("--upload", action="store_true", help="Upload the Colab notebook after setup using uv")
    parser.add_argument("--dry-run", action="store_true", help="Preview commands without login or Cloud changes")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args.project):
        parser.error("--project must be a 6–30 character project ID, using lowercase letters, digits, and hyphens; start with a letter and end with a letter or digit")

    commands = [["gcloud", "auth", "login", "--enable-gdrive-access", "--force"]]
    if args.create_project:
        commands.append(["gcloud", "projects", "create", args.project])
    commands.append(["gcloud", "services", "enable", "drive.googleapis.com", "--project", args.project])
    uploader = Path(__file__).resolve().with_name("upload-colab.py")
    upload_command = ["uv", "run", str(uploader), "--auth", "gcloud", "--project", args.project]
    if args.upload:
        commands.append(upload_command)

    print("Setup uses gcloud's Google Cloud and Google Drive authorization.", flush=True)
    print("Review the requested permissions in Google's consent screen. A custom desktop OAuth JSON is not needed.", flush=True)
    if args.dry_run:
        for command in commands:
            print(subprocess.list2cmdline(command))
        return

    gcloud = shutil.which("gcloud")
    if not gcloud:
        raise RuntimeError(
            "Google Cloud CLI is not installed or is not on PATH. On Windows, run "
            "'winget install --id Google.CloudSDK --exact', then reopen your terminal. "
            "Other platforms: https://cloud.google.com/sdk/docs/install"
        )
    uv = shutil.which("uv") if args.upload else None
    if args.upload and not uv:
        raise RuntimeError("--upload requires uv on PATH. Install uv or omit --upload.")
    for command in commands:
        executable = gcloud if command[0] == "gcloud" else uv
        print("Running: " + subprocess.list2cmdline(command), flush=True)
        result = subprocess.run([executable, *command[1:]], check=False)
        if result.returncode != 0:
            if command[0] == "uv":
                raise RuntimeError(
                    "Cloud setup completed, but the notebook upload failed. "
                    "Fix the reported upload error, then retry only:\n" +
                    subprocess.list2cmdline(upload_command)
                )
            raise RuntimeError(
                f"Setup stopped: {command[0]} {command[1]} failed. Check the command output. "
                "If project creation already succeeded, retry without --create-project."
            )

    if not args.upload:
        print("\nSetup complete. Upload with:")
        print(subprocess.list2cmdline(upload_command))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
