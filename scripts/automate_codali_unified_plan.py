#!/usr/bin/env python3
"""Run the Codali unified build plan phases through mcoda codex55.

This is a resumable queue runner for
docs/planning/codali-unified-data-storage-improvement-build-plan.md.

Default behavior:
- parse every "### Phase N: ..." section from the plan;
- create one implementation task and two review/alignment tasks per phase;
- run tasks with the local mcoda `codex55` agent;
- keep state, prompts, logs, and progress markdown under
  .codali_unified_plan_queue/;
- stop on the first unresolved failure unless --keep-going is provided;
- do not commit, push, tag, or publish unless --git-sync is explicitly used.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import time
from typing import Any


DEFAULT_AGENT = "codex55"
DEFAULT_PLAN_PATH = "docs/planning/codali-unified-data-storage-improvement-build-plan.md"
DEFAULT_PLAN_PROGRESS_PATH = "docs/planning/codali-unified-data-storage-improvement-build-progress.md"
DEFAULT_STORAGE_REPO = "/Users/bekirdag/Documents/apps/codali-storage-service"
DEFAULT_STATE_DIR = ".codali_unified_plan_queue"
DEFAULT_COMMAND_TEMPLATE = "mcoda agent-run {agent} --prompt-file {prompt_file}"
DEFAULT_USAGE_LIMIT_COMMAND_TEMPLATE = "mcoda agent limits --agent {agent} --json"
DEFAULT_GIT_COMMIT_TEMPLATE = "codali unified plan: {task_id}"

STATE_SCHEMA_VERSION = 1
INTERRUPTED_STATUS = "interrupted"
TERMINATED_STATUS = "terminated"
USAGE_LIMIT_STATUS = "usage_limited"
AGENT_UNAVAILABLE_STATUS = "agent_unavailable"
VALIDATION_FAILED_STATUS = "validation_failed"
GIT_PENDING_STATUS = "git_pending"
FAILED_STATUS = "failed"
COMPLETE_STATUS = "complete"
RUNNING_STATUS = "running"
PENDING_STATUS = "pending"

RETRYABLE_STOP_STATUSES = {
    FAILED_STATUS,
    INTERRUPTED_STATUS,
    TERMINATED_STATUS,
    USAGE_LIMIT_STATUS,
    AGENT_UNAVAILABLE_STATUS,
    VALIDATION_FAILED_STATUS,
    GIT_PENDING_STATUS,
}

RETRYABLE_TASK_FAILURE_STATUSES = {
    FAILED_STATUS,
    VALIDATION_FAILED_STATUS,
    TERMINATED_STATUS,
}

FILE_OPERATION_RETRIES = 5
FILE_OPERATION_RETRY_DELAY_SECONDS = 0.25


@dataclasses.dataclass(frozen=True)
class Phase:
    number: int
    title: str
    body: str
    start_line: int
    end_line: int
    target_repo_labels: tuple[str, ...]
    validation_block: str

    @property
    def slug(self) -> str:
        return f"phase-{self.number:02d}-{slugify(self.title)}"


@dataclasses.dataclass(frozen=True)
class QueueTask:
    task_id: str
    stage: str
    title: str
    prompt: str
    target_repo_labels: tuple[str, ...]
    phase_number: int | None = None
    phase_title: str = ""

    @property
    def prompt_hash(self) -> str:
        return hashlib.sha256(self.prompt.encode("utf-8")).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "task"


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def resolve_under_repo(repo_root: Path, value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = repo_root / path
    return path.resolve()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run Codali unified build-plan phases through mcoda codex55 with "
            "redundant implementation and review/alignment passes."
        )
    )
    parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    parser.add_argument("--storage-repo", type=Path, default=Path(DEFAULT_STORAGE_REPO))
    parser.add_argument("--plan", default=DEFAULT_PLAN_PATH)
    parser.add_argument(
        "--plan-progress",
        default=DEFAULT_PLAN_PROGRESS_PATH,
        help="Human planning progress document to mention in agent prompts.",
    )
    parser.add_argument(
        "--progress",
        default="",
        help="Queue progress markdown path. Defaults to <state-dir>/progress.md.",
    )
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--agent", default=DEFAULT_AGENT)
    parser.add_argument("--review-agent", default="")
    parser.add_argument("--command-template", default=DEFAULT_COMMAND_TEMPLATE)
    parser.add_argument("--usage-limit-command-template", default=DEFAULT_USAGE_LIMIT_COMMAND_TEMPLATE)
    parser.add_argument("--usage-limit-timeout-seconds", type=int, default=60)
    parser.add_argument("--skip-usage-limit-check", action="store_true")
    parser.add_argument("--skip-agent-health-check", action="store_true")
    parser.add_argument("--phase", type=int, action="append", default=[])
    parser.add_argument("--from-phase", type=int, default=None)
    parser.add_argument("--to-phase", type=int, default=None)
    parser.add_argument(
        "--stage",
        choices=("all", "implement", "review", "final-review"),
        default="all",
        help="Task stage subset to build.",
    )
    parser.add_argument("--review-passes", type=int, default=2)
    parser.add_argument("--no-final-review", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list", action="store_true", dest="list_only")
    parser.add_argument("--show-prompts", action="store_true")
    parser.add_argument("--max-runs", type=int, default=0)
    parser.add_argument("--timeout-seconds", type=int, default=0)
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--ignore-lock", action="store_true")
    parser.add_argument("--lock-retry-delay-seconds", type=int, default=30)
    parser.add_argument("--lock-max-wait-seconds", type=int, default=0)
    parser.add_argument(
        "--stale-stopped-lock-seconds",
        type=int,
        default=3600,
        help=(
            "Remove stopped/zombie local runner locks after this many seconds. "
            "Use 0 to disable stopped-process stale lock cleanup."
        ),
    )
    parser.add_argument("--agent-unavailable-retry-delay-seconds", type=int, default=300)
    parser.add_argument("--agent-unavailable-max-retries", type=int, default=0)
    parser.add_argument("--task-failure-retry-delay-seconds", type=int, default=60)
    parser.add_argument("--task-failure-max-retries", type=int, default=0)
    parser.add_argument(
        "--git-sync",
        action="store_true",
        help="Commit and push each successful task in each git-backed target repo.",
    )
    parser.add_argument("--git-remote", default="origin")
    parser.add_argument("--git-branch", default="main")
    parser.add_argument("--git-commit-template", default=DEFAULT_GIT_COMMIT_TEMPLATE)
    parser.add_argument("--git-timeout-seconds", type=int, default=300)
    parser.add_argument("--no-empty-commit", action="store_true")
    args = parser.parse_args(argv)
    if args.review_passes < 0:
        parser.error("--review-passes must be 0 or greater")
    for name in (
        "max_runs",
        "timeout_seconds",
        "usage_limit_timeout_seconds",
        "lock_retry_delay_seconds",
        "lock_max_wait_seconds",
        "stale_stopped_lock_seconds",
        "agent_unavailable_retry_delay_seconds",
        "agent_unavailable_max_retries",
        "task_failure_retry_delay_seconds",
        "task_failure_max_retries",
        "git_timeout_seconds",
    ):
        if getattr(args, name) < 0:
            parser.error(f"--{name.replace('_', '-')} must be 0 or greater")
    return args


def phase_matches(phase: Phase, args: argparse.Namespace) -> bool:
    if args.phase and phase.number not in set(args.phase):
        return False
    if args.from_phase is not None and phase.number < args.from_phase:
        return False
    if args.to_phase is not None and phase.number > args.to_phase:
        return False
    return True


def parse_target_repo_labels(body: str) -> tuple[str, ...]:
    labels: list[str] = []
    lines = body.splitlines()
    for index, line in enumerate(lines):
        if line.strip().lower() not in {"target repo:", "target repos:"}:
            continue
        for candidate in lines[index + 1 :]:
            stripped = candidate.strip()
            if not stripped:
                break
            if not stripped.startswith("- "):
                break
            label = stripped[2:].strip().strip("`")
            normalized = label.lower()
            if "codali-storage-service" in normalized:
                labels.append("codali-storage-service")
            elif "mcoda" in normalized:
                labels.append("mcoda")
    if not labels:
        labels.append("mcoda")
    return tuple(dict.fromkeys(labels))


def parse_validation_block(body: str) -> str:
    marker = "Validation:"
    start = body.find(marker)
    if start < 0:
        return ""
    tail = body[start + len(marker) :]
    match = re.search(r"```(?:text|bash|sh)?\n(.*?)```", tail, re.DOTALL)
    if not match:
        return ""
    return match.group(1).strip()


def parse_phases(plan_path: Path) -> list[Phase]:
    text = plan_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    headings: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines, start=1):
        match = re.match(r"^### Phase\s+(\d+):\s*(.+?)\s*$", line)
        if match:
            headings.append((index, int(match.group(1)), match.group(2).strip()))
    phases: list[Phase] = []
    for offset, (start_line, number, title) in enumerate(headings):
        end_line = headings[offset + 1][0] - 1 if offset + 1 < len(headings) else len(lines)
        body_lines = lines[start_line - 1 : end_line]
        body = "\n".join(body_lines).strip()
        phases.append(
            Phase(
                number=number,
                title=title,
                body=body,
                start_line=start_line,
                end_line=end_line,
                target_repo_labels=parse_target_repo_labels(body),
                validation_block=parse_validation_block(body),
            )
        )
    return phases


def repo_map(repo_root: Path, storage_repo: Path) -> dict[str, Path]:
    return {
        "mcoda": repo_root,
        "codali-storage-service": storage_repo,
    }


def target_repos_text(repo_root: Path, storage_repo: Path, labels: tuple[str, ...]) -> str:
    repos = repo_map(repo_root, storage_repo)
    return "\n".join(f"- {label}: {repos[label]}" for label in labels if label in repos)


def global_prompt_rules(repo_root: Path, storage_repo: Path, plan_path: Path, plan_progress_path: Path) -> str:
    return f"""You are the mcoda codex55 automation worker on the local box.

Primary plan:
- {plan_path}

Progress document to keep updated when useful:
- {plan_progress_path}

Repositories:
- mcoda: {repo_root}
- codali-storage-service: {storage_repo}

Hard requirements:
- Implement the requested phase against the real codebase, not just documentation.
- Compare requirements to the current code before claiming completion.
- Patch missing or misaligned code, tests, config, docs, and contracts directly.
- Use Docdex/repo search and impact analysis before code changes where available.
- Preserve user changes. Do not revert unrelated dirty work.
- Keep Codali and storage-service core product-neutral; do not hardcode OKACAM, Suku, tenant, model, or tool names in core logic.
- Use mcoda agent inventory/runtime capability data for model or agent selection.
- Keep default storage local-only and upload disabled.
- Keep collection non-blocking for gateway answers.
- Do not enable write/shell/destructive runtime tools unless the phase explicitly requires guarded implementation.
- Do not train or export customer data unless privacy metadata and policy allow it.
- Do not fine-tune the final synthesizer first.
- Do not tag, push, publish, or run npm release workflows. The queue runner owns git sync only when explicitly configured.
- If a validation command from the plan is not implemented yet, create the missing implementation or record a precise blocker and add a deterministic interim test.
- Run targeted tests/build checks that fit the phase and record the commands and outcomes in your response.
"""


def build_implement_prompt(
    repo_root: Path,
    storage_repo: Path,
    plan_path: Path,
    plan_progress_path: Path,
    phase: Phase,
) -> str:
    validation = phase.validation_block or "(No explicit validation block found; derive focused validation from the phase acceptance criteria.)"
    return (
        global_prompt_rules(repo_root, storage_repo, plan_path, plan_progress_path)
        + f"""
Task:
Implement Phase {phase.number}: {phase.title}

Target repositories:
{target_repos_text(repo_root, storage_repo, phase.target_repo_labels)}

Phase source, lines {phase.start_line}-{phase.end_line}:
```markdown
{phase.body}
```

Required work:
- Inspect the target repo(s) and identify the exact existing or missing files for this phase.
- Implement the phase end-to-end in the smallest production-safe slice.
- Add or update tests appropriate to the phase.
- Update progress docs with actual implementation and validation evidence when appropriate.
- Keep changes aligned with all non-negotiable invariants in the unified plan.
- Do not stop at a proposal.

Expected validation for this phase:
```text
{validation}
```

Completion evidence:
- List changed files.
- List implemented requirements.
- List validation commands and outcomes.
- List any remaining blocker that could not be resolved in code.
"""
    )


def build_review_prompt(
    repo_root: Path,
    storage_repo: Path,
    plan_path: Path,
    plan_progress_path: Path,
    phase: Phase,
    pass_number: int,
) -> str:
    validation = phase.validation_block or "(No explicit validation block found; derive focused validation from acceptance criteria.)"
    return (
        global_prompt_rules(repo_root, storage_repo, plan_path, plan_progress_path)
        + f"""
Task:
Review and align Phase {phase.number}: {phase.title}

This is redundant review/alignment pass {pass_number}. Compare the phase requirements to the actual codebase in the target repos. Do not only review the previous worker output.

Target repositories:
{target_repos_text(repo_root, storage_repo, phase.target_repo_labels)}

Phase source, lines {phase.start_line}-{phase.end_line}:
```markdown
{phase.body}
```

Review and repair requirements:
- Search the codebase for each required contract, API, module, command, test, config flag, privacy gate, storage table, or runtime behavior named by this phase.
- Identify every missing, partial, or misaligned implementation detail.
- Patch gaps directly.
- If the phase is already complete, leave code unchanged and report the evidence.
- Verify the implementation against acceptance criteria and validation commands.
- Update progress docs with validation evidence when useful.

Expected validation for this phase:
```text
{validation}
```

Completion evidence:
- Findings checked.
- Gaps fixed.
- Changed files, if any.
- Validation commands and outcomes.
- Explicit confirmation that the phase now matches the codebase or a precise blocker.
"""
    )


def build_final_review_prompt(
    repo_root: Path,
    storage_repo: Path,
    plan_path: Path,
    plan_progress_path: Path,
    phases: list[Phase],
) -> str:
    phase_index = "\n".join(f"- Phase {phase.number}: {phase.title}" for phase in phases)
    return (
        global_prompt_rules(repo_root, storage_repo, plan_path, plan_progress_path)
        + f"""
Task:
Run a final cross-phase review for the full Codali unified data, storage, and auto-improvement build plan.

Phases included:
{phase_index}

Required work:
- Compare the full plan to the codebase across both repos.
- Find missing cross-phase contracts, naming mismatches, duplicate abstractions, unimplemented gates, broken validation commands, and product-specific leakage.
- Patch any remaining gaps that can be fixed safely.
- Ensure storage-service, Codali dataset collection, mswarm metadata, improvement candidates, release gates, and rollout controls remain aligned.
- Do not tag, push, publish, or start external uploads.

Completion evidence:
- Cross-phase findings.
- Files changed.
- Validation commands and outcomes.
- Remaining blockers, if any.
"""
    )


def build_tasks(
    repo_root: Path,
    storage_repo: Path,
    plan_path: Path,
    plan_progress_path: Path,
    phases: list[Phase],
    args: argparse.Namespace,
) -> list[QueueTask]:
    tasks: list[QueueTask] = []
    selected = [phase for phase in phases if phase_matches(phase, args)]
    for phase in selected:
        if args.stage in {"all", "implement"}:
            tasks.append(
                QueueTask(
                    task_id=f"{phase.slug}-implement",
                    stage="implement",
                    title=f"Implement Phase {phase.number}: {phase.title}",
                    prompt=build_implement_prompt(repo_root, storage_repo, plan_path, plan_progress_path, phase),
                    target_repo_labels=phase.target_repo_labels,
                    phase_number=phase.number,
                    phase_title=phase.title,
                )
            )
        if args.stage in {"all", "review"}:
            for review_pass in range(1, args.review_passes + 1):
                tasks.append(
                    QueueTask(
                        task_id=f"{phase.slug}-review-align-{review_pass}",
                        stage="review",
                        title=f"Review Phase {phase.number}: {phase.title} pass {review_pass}",
                        prompt=build_review_prompt(
                            repo_root,
                            storage_repo,
                            plan_path,
                            plan_progress_path,
                            phase,
                            review_pass,
                        ),
                        target_repo_labels=phase.target_repo_labels,
                        phase_number=phase.number,
                        phase_title=phase.title,
                    )
                )
    if (
        not args.no_final_review
        and args.stage in {"all", "final-review"}
        and not args.phase
        and args.from_phase is None
        and args.to_phase is None
    ):
        tasks.append(
            QueueTask(
                task_id="999-final-cross-phase-review",
                stage="final-review",
                title="Final cross-phase review and alignment",
                prompt=build_final_review_prompt(repo_root, storage_repo, plan_path, plan_progress_path, selected),
                target_repo_labels=("mcoda", "codali-storage-service"),
            )
        )
    return tasks


def clear_user_file_flags(path: Path) -> None:
    if not hasattr(os, "chflags"):
        return
    clear_mask = 0
    for name in ("UF_APPEND", "UF_IMMUTABLE"):
        clear_mask |= int(getattr(stat, name, 0))
    if not clear_mask:
        return
    try:
        flags = os.stat(path).st_flags
    except (AttributeError, FileNotFoundError, PermissionError):
        return
    if flags & clear_mask:
        os.chflags(path, flags & ~clear_mask)


def make_path_writable(path: Path) -> None:
    for candidate in (path, path.parent):
        try:
            clear_user_file_flags(candidate)
        except OSError:
            pass
        try:
            mode = candidate.stat().st_mode
        except (FileNotFoundError, PermissionError):
            continue
        wanted = stat.S_IWUSR
        if candidate.is_dir():
            wanted |= stat.S_IXUSR
        if mode & wanted != wanted:
            try:
                os.chmod(candidate, mode | wanted)
            except OSError:
                pass


def retry_delay(attempt: int) -> None:
    if attempt + 1 < FILE_OPERATION_RETRIES:
        time.sleep(FILE_OPERATION_RETRY_DELAY_SECONDS)


def write_text_atomic(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    last_error: PermissionError | None = None
    for attempt in range(FILE_OPERATION_RETRIES):
        tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
        try:
            make_path_writable(path)
            tmp_path.write_text(text, encoding=encoding)
            tmp_path.replace(path)
            return
        except PermissionError as exc:
            last_error = exc
            make_path_writable(path)
            retry_delay(attempt)
        finally:
            try:
                tmp_path.unlink()
            except (FileNotFoundError, OSError):
                pass
    if last_error is not None:
        raise PermissionError(f"could not write {path} after retries: {last_error}") from last_error
    raise RuntimeError(f"could not write {path}")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    write_text_atomic(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def load_state(state_path: Path, args: argparse.Namespace, repo_root: Path, storage_repo: Path) -> dict[str, Any]:
    if not state_path.exists():
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "repo_root": str(repo_root),
            "storage_repo": str(storage_repo),
            "agent": args.agent,
            "review_agent": args.review_agent or args.agent,
            "tasks": {},
        }
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if state.get("schema_version") != STATE_SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported state schema version in {state_path}: {state.get('schema_version')}")
    state.setdefault("tasks", {})
    return state


def write_state(state_path: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = utc_now()
    write_json_atomic(state_path, state)


@dataclasses.dataclass(frozen=True)
class RunnerLockInfo:
    pid: int | None
    acquired_at: dt.datetime | None


def parse_lock_timestamp(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def runner_lock_age_seconds(info: RunnerLockInfo) -> float | None:
    if info.acquired_at is None:
        return None
    return max(0.0, (dt.datetime.now(dt.timezone.utc) - info.acquired_at).total_seconds())


def runner_lock_age_text(info: RunnerLockInfo) -> str:
    age = runner_lock_age_seconds(info)
    if age is None:
        return "unknown age"
    return f"{int(age)}s old"


def process_state(pid: int) -> str:
    if pid <= 0:
        return "dead"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "dead"
    except PermissionError:
        return "alive"
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "stat="],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return "alive"
    if result.returncode != 0:
        return "dead"
    status = result.stdout.strip()
    if not status:
        return "alive"
    first = status[0].upper()
    if first == "T":
        return "stopped"
    if first == "Z":
        return "zombie"
    return "alive"


def pid_is_running(pid: int) -> bool:
    return process_state(pid) == "alive"


def read_runner_lock_info(lock_path: Path) -> RunnerLockInfo:
    try:
        lines = lock_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return RunnerLockInfo(pid=None, acquired_at=None)
    try:
        pid = int(lines[0])
    except (IndexError, ValueError):
        pid = None
    acquired_at = parse_lock_timestamp(lines[1] if len(lines) > 1 else None)
    return RunnerLockInfo(pid=pid, acquired_at=acquired_at)


def read_runner_lock_pid(lock_path: Path) -> int | None:
    return read_runner_lock_info(lock_path).pid


def runner_lock_can_be_removed(
    info: RunnerLockInfo,
    ignore_existing: bool,
    stale_stopped_lock_seconds: int,
) -> tuple[bool, str, str]:
    state = process_state(info.pid or -1)
    if ignore_existing:
        return True, state, "ignore-lock"
    if state == "dead":
        return True, state, "stale"
    if state == "zombie":
        return True, state, "zombie"
    if state == "stopped" and stale_stopped_lock_seconds > 0:
        age = runner_lock_age_seconds(info)
        if age is not None and age >= stale_stopped_lock_seconds:
            return True, state, "stale stopped"
    return False, state, "active"


class RunnerLock:
    def __init__(
        self,
        path: Path,
        ignore_existing: bool,
        lock_retry_delay_seconds: int,
        lock_max_wait_seconds: int,
        stale_stopped_lock_seconds: int,
    ) -> None:
        self.path = path
        self.ignore_existing = ignore_existing
        self.lock_retry_delay_seconds = lock_retry_delay_seconds
        self.lock_max_wait_seconds = lock_max_wait_seconds
        self.stale_stopped_lock_seconds = stale_stopped_lock_seconds
        self.fd: int | None = None

    def __enter__(self) -> "RunnerLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        started_at = time.monotonic()
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                info = read_runner_lock_info(self.path)
                removable, state, reason = runner_lock_can_be_removed(
                    info,
                    self.ignore_existing,
                    self.stale_stopped_lock_seconds,
                )
                if removable:
                    warn(
                        f"removing {reason} runner lock at {self.path} "
                        f"for pid {info.pid} ({state}, {runner_lock_age_text(info)})"
                    )
                    try:
                        self.path.unlink()
                    except FileNotFoundError:
                        pass
                    continue
                elapsed = time.monotonic() - started_at
                if self.lock_max_wait_seconds and elapsed >= self.lock_max_wait_seconds:
                    raise RuntimeError(f"Runner lock is active at {self.path} for pid {info.pid}")
                delay = max(1, self.lock_retry_delay_seconds)
                print(
                    f"Runner lock active at {self.path} for pid {info.pid} "
                    f"({state}, {runner_lock_age_text(info)}); waiting {delay}s."
                )
                time.sleep(delay)
        if self.fd is None:
            raise RuntimeError(f"Unable to create runner lock at {self.path}")
        os.write(self.fd, f"{os.getpid()}\n{utc_now()}\n".encode("utf-8"))
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def task_record(state: dict[str, Any], task: QueueTask) -> dict[str, Any] | None:
    value = state.setdefault("tasks", {}).get(task.task_id)
    return value if isinstance(value, dict) else None


def ensure_task_record(state: dict[str, Any], task: QueueTask) -> dict[str, Any]:
    tasks = state.setdefault("tasks", {})
    record = tasks.get(task.task_id)
    if not isinstance(record, dict):
        record = {}
        tasks[task.task_id] = record
    if record.get("prompt_hash") and record.get("prompt_hash") != task.prompt_hash:
        history = record.setdefault("superseded_attempt_sets", [])
        history.append(
            {
                "superseded_at": utc_now(),
                "old_prompt_hash": record.get("prompt_hash"),
                "old_status": record.get("status", PENDING_STATUS),
                "old_attempts": record.get("attempts", []),
            }
        )
        if record.get("status") != COMPLETE_STATUS:
            record["status"] = PENDING_STATUS
            record["attempts"] = []
    record.setdefault("attempts", [])
    record.update(
        {
            "task_id": task.task_id,
            "stage": task.stage,
            "title": task.title,
            "target_repo_labels": list(task.target_repo_labels),
            "phase_number": task.phase_number,
            "phase_title": task.phase_title,
            "prompt_hash": task.prompt_hash,
        }
    )
    return record


def task_status(state: dict[str, Any], task: QueueTask) -> str:
    record = task_record(state, task)
    if not record:
        return PENDING_STATUS
    status = str(record.get("status") or PENDING_STATUS)
    if record.get("prompt_hash") and record.get("prompt_hash") != task.prompt_hash and status != COMPLETE_STATUS:
        return PENDING_STATUS
    return status


def normalize_stale_running_tasks(tasks: list[QueueTask], state: dict[str, Any], state_path: Path) -> None:
    changed = False
    for task in tasks:
        record = task_record(state, task)
        if record and record.get("status") == RUNNING_STATUS:
            record["status"] = INTERRUPTED_STATUS
            record["normalized_at"] = utc_now()
            changed = True
    if changed:
        write_state(state_path, state)


def summarize(tasks: list[QueueTask], state: dict[str, Any]) -> dict[str, int]:
    counts = {
        COMPLETE_STATUS: 0,
        FAILED_STATUS: 0,
        RUNNING_STATUS: 0,
        GIT_PENDING_STATUS: 0,
        USAGE_LIMIT_STATUS: 0,
        AGENT_UNAVAILABLE_STATUS: 0,
        INTERRUPTED_STATUS: 0,
        TERMINATED_STATUS: 0,
        VALIDATION_FAILED_STATUS: 0,
        PENDING_STATUS: 0,
    }
    for task in tasks:
        status = task_status(state, task)
        counts[status if status in counts else FAILED_STATUS] += 1
    return counts


def pending_tasks(tasks: list[QueueTask], state: dict[str, Any]) -> list[QueueTask]:
    return [task for task in tasks if task_status(state, task) != COMPLETE_STATUS]


def print_summary(tasks: list[QueueTask], state: dict[str, Any]) -> None:
    counts = summarize(tasks, state)
    print(
        "Summary: "
        f"{counts[COMPLETE_STATUS]} complete, "
        f"{counts[FAILED_STATUS]} failed, "
        f"{counts[VALIDATION_FAILED_STATUS]} validation_failed, "
        f"{counts[GIT_PENDING_STATUS]} git_pending, "
        f"{counts[USAGE_LIMIT_STATUS]} usage_limited, "
        f"{counts[AGENT_UNAVAILABLE_STATUS]} agent_unavailable, "
        f"{counts[PENDING_STATUS]} pending / {len(tasks)} total"
    )


def write_progress_markdown(progress_path: Path, tasks: list[QueueTask], state: dict[str, Any]) -> None:
    counts = summarize(tasks, state)
    stages: dict[str, int] = {}
    for task in tasks:
        stages[task.stage] = stages.get(task.stage, 0) + 1
    next_items = pending_tasks(tasks, state)[:15]
    lines = [
        "# Codali Unified Plan Automation Progress",
        "",
        f"- Updated: {utc_now()}",
        f"- Agent: {state.get('agent')}",
        f"- Review agent: {state.get('review_agent')}",
        f"- Plan: {state.get('plan_path')}",
        f"- Total tasks: {len(tasks)}",
        f"- Complete: {counts[COMPLETE_STATUS]}",
        f"- Failed: {counts[FAILED_STATUS]}",
        f"- Validation failed: {counts[VALIDATION_FAILED_STATUS]}",
        f"- Git pending: {counts[GIT_PENDING_STATUS]}",
        f"- Usage limited: {counts[USAGE_LIMIT_STATUS]}",
        f"- Agent unavailable: {counts[AGENT_UNAVAILABLE_STATUS]}",
        f"- Pending: {counts[PENDING_STATUS]}",
        "",
        "## Stage Totals",
        "",
    ]
    for stage, count in sorted(stages.items()):
        lines.append(f"- {stage}: {count}")
    lines.extend(["", "## Next Incomplete Tasks", ""])
    if next_items:
        for task in next_items:
            phase = f"phase {task.phase_number}" if task.phase_number is not None else "global"
            lines.append(f"- `{task.task_id}`: {task_status(state, task)}, {phase}, {task.stage}")
    else:
        lines.append("- None.")
    lines.append("")
    write_text_atomic(progress_path, "\n".join(lines))


def safe_write_progress_markdown(progress_path: Path, tasks: list[QueueTask], state: dict[str, Any]) -> None:
    try:
        write_progress_markdown(progress_path, tasks, state)
    except OSError as exc:
        warn(f"could not update progress markdown at {progress_path}: {exc}")


def prompt_file_path(state_dir: Path, task: QueueTask) -> Path:
    return state_dir / "prompts" / f"{task.task_id}.txt"


def log_file_path(state_dir: Path, task: QueueTask, attempt: int) -> Path:
    return state_dir / "logs" / f"{task.task_id}.attempt-{attempt:03d}.log"


def command_for_task(template: str, agent: str, task: QueueTask, repo_root: Path, prompt_file: Path) -> list[str]:
    values = {
        "agent": shlex.quote(agent),
        "prompt_file": shlex.quote(str(prompt_file)),
        "prompt": shlex.quote(task.prompt),
        "repo_root": shlex.quote(str(repo_root)),
        "task_id": shlex.quote(task.task_id),
        "stage": shlex.quote(task.stage),
    }
    return shlex.split(template.format(**values))


def command_for_usage_limit_check(template: str, agent: str) -> list[str]:
    return shlex.split(template.format(agent=shlex.quote(agent)))


def parse_json_list(raw_output: str) -> list[Any]:
    payload = json.loads(raw_output.strip() or "[]")
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("records", "limits", "items", "data", "agents"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise ValueError("JSON payload did not contain a list")


def value_mentions_blocked(value: Any) -> bool:
    text = str(value).strip().lower().replace("_", " ").replace("-", " ")
    return any(
        marker in text
        for marker in (
            "active",
            "blocked",
            "limited",
            "usage limited",
            "quota exceeded",
            "rate limited",
        )
    )


def usage_limit_record_blocks(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    for key in ("blocked", "active", "limited", "isLimited", "usage_limited", "status", "state", "reason"):
        if key in record and value_mentions_blocked(record.get(key)):
            return True
    return False


def ensure_agent_usage_available(
    args: argparse.Namespace,
    repo_root: Path,
    state_path: Path,
    state: dict[str, Any],
    agent: str,
) -> bool:
    if args.skip_usage_limit_check:
        return True
    command = command_for_usage_limit_check(args.usage_limit_command_template, agent)
    timeout = None if args.usage_limit_timeout_seconds <= 0 else args.usage_limit_timeout_seconds
    try:
        result = subprocess.run(
            command,
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        state["last_usage_limit_check"] = {
            "checked_at": utc_now(),
            "agent": agent,
            "blocked": True,
            "reason": type(exc).__name__,
            "error": str(exc),
            "command": command,
        }
        write_state(state_path, state)
        return False
    raw_output = result.stdout or ""
    if result.returncode != 0:
        state["last_usage_limit_check"] = {
            "checked_at": utc_now(),
            "agent": agent,
            "blocked": True,
            "reason": f"exit_{result.returncode}",
            "raw_output": raw_output,
            "command": command,
        }
        write_state(state_path, state)
        return False
    try:
        records = parse_json_list(raw_output)
    except (json.JSONDecodeError, ValueError) as exc:
        state["last_usage_limit_check"] = {
            "checked_at": utc_now(),
            "agent": agent,
            "blocked": True,
            "reason": "invalid_json",
            "raw_output": raw_output,
            "error": str(exc),
            "command": command,
        }
        write_state(state_path, state)
        return False
    blocked = any(usage_limit_record_blocks(record) for record in records)
    state["last_usage_limit_check"] = {
        "checked_at": utc_now(),
        "agent": agent,
        "blocked": blocked,
        "records": records,
        "command": command,
    }
    write_state(state_path, state)
    return not blocked


def health_status_from_agent(item: dict[str, Any]) -> str:
    for key in ("health_status", "healthStatus", "status"):
        value = item.get(key)
        if value:
            return str(value)
    health = item.get("health")
    if isinstance(health, dict):
        return str(health.get("status") or "")
    return ""


def ensure_agent_health(repo_root: Path, args: argparse.Namespace) -> tuple[bool, str]:
    if args.skip_agent_health_check:
        return True, "skipped"
    agents_to_check = {args.agent}
    if args.review_agent:
        agents_to_check.add(args.review_agent)
    try:
        result = subprocess.run(
            ["mcoda", "agent", "list", "--json", "--refresh-health"],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"agent_health_check_failed:{type(exc).__name__}:{exc}"
    if result.returncode != 0:
        return False, f"agent_health_check_exit_{result.returncode}:{result.stdout[-1200:]}"
    try:
        agents = parse_json_list(result.stdout or "[]")
    except (json.JSONDecodeError, ValueError) as exc:
        return False, f"agent_health_check_invalid_json:{exc}"
    by_slug: dict[str, dict[str, Any]] = {}
    for item in agents:
        if isinstance(item, dict):
            for key in ("slug", "id", "name"):
                value = item.get(key)
                if value:
                    by_slug[str(value)] = item
    for agent in sorted(agents_to_check):
        item = by_slug.get(agent)
        if not item:
            return False, f"agent_not_found:{agent}"
        status = health_status_from_agent(item)
        if status and status != "healthy":
            return False, f"agent_not_healthy:{agent}:{status}"
    return True, "ok"


def read_log_excerpt(log_path: Path, max_chars: int = 5000) -> str:
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    return text[-max_chars:]


def normalized_log_text(log_path: Path) -> str:
    return read_log_excerpt(log_path).lower().replace("-", " ").replace("_", " ")


def log_indicates_usage_limit(log_path: Path) -> bool:
    text = normalized_log_text(log_path)
    return any(marker in text for marker in ("usage limit", "rate limit", "quota exceeded", "usage limited", "rate limited"))


def log_indicates_agent_unavailable(log_path: Path) -> bool:
    text = normalized_log_text(log_path)
    return any(
        marker in text
        for marker in (
            "upstream error",
            "service unavailable",
            "backend unavailable",
            "provider unavailable",
            "connection refused",
            "connection reset",
            "connection timed out",
            "codex cli timed out",
            "auth error",
            "econnrefused",
            "503",
        )
    )


def retry_prompt_for_attempt(task: QueueTask, record: dict[str, Any], attempt_no: int) -> str:
    if attempt_no <= 1:
        return task.prompt
    lines = [
        "",
        "",
        "Retry repair context:",
        f"- This is attempt {attempt_no} for {task.task_id}.",
        "- A previous attempt did not complete cleanly. Repair the task autonomously.",
        "- Do not ask the user for input. Do not run git commit, git push, git tag, or npm publish.",
    ]
    validation_errors = record.get("validation_errors")
    if validation_errors:
        lines.append("- Previous validation errors:")
        for error in validation_errors:
            lines.append(f"  - {error}")
    last_log_path = record.get("last_log_path")
    if last_log_path:
        excerpt = read_log_excerpt(Path(str(last_log_path)), max_chars=3000).strip()
        if excerpt:
            lines.extend(["- Previous log excerpt:", "```text", excerpt, "```"])
    lines.append("- Required result: finish the phase slice and leave deterministic validation passing.")
    return task.prompt + "\n".join(lines) + "\n"


def signal_name_for_exit_code(exit_code: int) -> str | None:
    if exit_code >= 0:
        return None
    try:
        return signal.Signals(-exit_code).name
    except ValueError:
        return None


def is_git_repo(path: Path) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=path,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return result.returncode == 0 and "true" in (result.stdout or "").lower()


def run_validation_command(command: list[str], cwd: Path, timeout_seconds: int = 300) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"{shlex.join(command)} failed to run in {cwd}: {exc}"
    if result.returncode != 0:
        return False, f"{shlex.join(command)} failed in {cwd} (exit {result.returncode}): {(result.stdout or '')[-2000:]}"
    return True, ""


def scan_merge_conflict_markers(repo: Path) -> str:
    try:
        result = subprocess.run(
            ["rg", "-n", r"^(<<<<<<<|=======|>>>>>>>)", "."],
            cwd=repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"merge conflict marker scan failed in {repo}: {exc}"
    if result.returncode == 0:
        return f"merge conflict markers found in {repo}: {(result.stdout or '')[-2000:]}"
    if result.returncode == 1:
        return ""
    return f"merge conflict marker scan failed in {repo} (exit {result.returncode}): {(result.stdout or '')[-2000:]}"


def validate_repo_after_task(task: QueueTask, repos: dict[str, Path]) -> list[str]:
    errors: list[str] = []
    for label in task.target_repo_labels:
        repo = repos.get(label)
        if not repo or not repo.exists():
            errors.append(f"target repo missing: {label} -> {repo}")
            continue
        if is_git_repo(repo):
            ok, error = run_validation_command(["git", "diff", "--check"], repo)
            if not ok:
                errors.append(error)
        conflict_error = scan_merge_conflict_markers(repo)
        if conflict_error:
            errors.append(conflict_error)
    return errors


def select_agent_for_task(task: QueueTask, args: argparse.Namespace) -> str:
    if task.stage in {"review", "final-review"} and args.review_agent:
        return args.review_agent
    return args.agent


def prompt_path_for_task(state_dir: Path, task: QueueTask) -> Path:
    return prompt_file_path(state_dir, task)


def format_git_commit_message(task: QueueTask, args: argparse.Namespace) -> str:
    values = {
        "agent": select_agent_for_task(task, args),
        "task_id": task.task_id,
        "stage": task.stage,
        "title": task.title,
        "phase": task.phase_number if task.phase_number is not None else "global",
    }
    try:
        message = args.git_commit_template.format(**values)
    except KeyError as exc:
        raise RuntimeError(f"Unknown git commit template placeholder: {exc}") from exc
    return " ".join(message.splitlines()).strip() or DEFAULT_GIT_COMMIT_TEMPLATE.format(**values)


def run_git_sync_for_repo(task: QueueTask, repo: Path, state_dir: Path, args: argparse.Namespace) -> tuple[bool, dict[str, Any]]:
    log_path = state_dir / "logs" / f"{task.task_id}.git-sync-{slugify(str(repo))}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record: dict[str, Any] = {"repo": str(repo), "log_path": str(log_path), "started_at": utc_now()}
    if not is_git_repo(repo):
        record["status"] = "skipped"
        record["reason"] = "not_git_repo"
        return True, record
    with log_path.open("a", encoding="utf-8") as log_file:
        for command in (
            ["git", "add", "-A"],
            ["git", "diff", "--cached", "--quiet"],
        ):
            log_file.write(f"\n$ {shlex.join(command)}\n")
            result = subprocess.run(
                command,
                cwd=repo,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=None if args.git_timeout_seconds <= 0 else args.git_timeout_seconds,
            )
            log_file.write(result.stdout or "")
            log_file.write(f"\n(exit {result.returncode})\n")
            if command[1] == "diff":
                has_staged_changes = result.returncode == 1
                if result.returncode not in (0, 1):
                    record["status"] = "failed"
                    record["error"] = "git_diff_failed"
                    return False, record
            elif result.returncode != 0:
                record["status"] = "failed"
                record["error"] = "git_add_failed"
                return False, record
        if not has_staged_changes and args.no_empty_commit:
            record["status"] = "skipped"
            record["reason"] = "no_staged_changes"
            return True, record
        message = format_git_commit_message(task, args)
        commit = ["git", "commit", "-m", message]
        if not has_staged_changes:
            commit.insert(2, "--allow-empty")
        for command in (commit, ["git", "push", args.git_remote, f"HEAD:{args.git_branch}"]):
            log_file.write(f"\n$ {shlex.join(command)}\n")
            result = subprocess.run(
                command,
                cwd=repo,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=None if args.git_timeout_seconds <= 0 else args.git_timeout_seconds,
            )
            log_file.write(result.stdout or "")
            log_file.write(f"\n(exit {result.returncode})\n")
            if result.returncode != 0:
                record["status"] = "failed"
                record["error"] = "git_commit_failed" if command[1] == "commit" else "git_push_failed"
                return False, record
    record["status"] = COMPLETE_STATUS
    record["completed_at"] = utc_now()
    return True, record


def complete_git_pending_task(
    task: QueueTask,
    tasks: list[QueueTask],
    index: int,
    total: int,
    repos: dict[str, Path],
    state_dir: Path,
    state_path: Path,
    state: dict[str, Any],
    progress_path: Path,
    args: argparse.Namespace,
) -> bool:
    record = task_record(state, task)
    if record is None:
        raise RuntimeError(f"Missing task record for git-pending task {task.task_id}")
    print(f"[{index}/{total}] Running git sync for {task.task_id}")
    sync_records: list[dict[str, Any]] = []
    ok = True
    for label in task.target_repo_labels:
        repo = repos.get(label)
        if not repo:
            continue
        repo_ok, sync_record = run_git_sync_for_repo(task, repo, state_dir, args)
        sync_record["label"] = label
        sync_records.append(sync_record)
        ok = ok and repo_ok
    record["git_sync"] = sync_records
    record["status"] = COMPLETE_STATUS if ok else GIT_PENDING_STATUS
    write_state(state_path, state)
    safe_write_progress_markdown(progress_path, tasks, state)
    print(f"[{index}/{total}] Git sync {'complete' if ok else 'failed'} for {task.task_id}")
    return ok


def run_task(
    task: QueueTask,
    tasks: list[QueueTask],
    index: int,
    total: int,
    repo_root: Path,
    repos: dict[str, Path],
    state_dir: Path,
    state_path: Path,
    state: dict[str, Any],
    progress_path: Path,
    args: argparse.Namespace,
) -> bool:
    record = ensure_task_record(state, task)
    attempt_no = len(record.get("attempts", [])) + 1
    prompt_path = prompt_path_for_task(state_dir, task)
    log_path = log_file_path(state_dir, task, attempt_no)
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    attempt_prompt = retry_prompt_for_attempt(task, record, attempt_no)
    write_text_atomic(prompt_path, attempt_prompt + "\n")

    agent = select_agent_for_task(task, args)
    command = command_for_task(args.command_template, agent, task, repo_root, prompt_path)
    started_at = utc_now()
    record.update(
        {
            "status": RUNNING_STATUS,
            "last_started_at": started_at,
            "last_completed_at": None,
            "last_exit_code": None,
            "last_log_path": str(log_path),
            "last_prompt_path": str(prompt_path),
            "command": command,
            "agent": agent,
        }
    )
    record["attempts"].append(
        {
            "attempt": attempt_no,
            "started_at": started_at,
            "prompt_path": str(prompt_path),
            "log_path": str(log_path),
            "command": command,
            "agent": agent,
        }
    )
    write_state(state_path, state)
    safe_write_progress_markdown(progress_path, tasks, state)

    print(f"[{index}/{total}] Running {task.task_id} ({task.stage}, attempt={attempt_no})")
    print(f"Log: {log_path}")
    timeout = None if args.timeout_seconds <= 0 else args.timeout_seconds
    exit_code = 1
    timed_out = False
    interrupted_by_keyboard = False

    with log_path.open("w", encoding="utf-8") as log_file:
        log_file.write(f"Started: {started_at}\n")
        log_file.write(f"Task: {task.task_id}\n")
        log_file.write(f"Agent: {agent}\n")
        log_file.write(f"Command: {shlex.join(command)}\n\n")
        log_file.write("Prompt:\n")
        log_file.write(attempt_prompt)
        log_file.write("\n\nOutput:\n")
        log_file.flush()
        process = subprocess.Popen(command, cwd=repo_root, stdout=log_file, stderr=subprocess.STDOUT, text=True)
        try:
            exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            process.wait()
            exit_code = 124
            log_file.write(f"\nTimed out after {args.timeout_seconds} seconds.\n")
        except KeyboardInterrupt:
            interrupted_by_keyboard = True
            process.terminate()
            try:
                exit_code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                exit_code = process.wait()
            log_file.write("\nInterrupted by KeyboardInterrupt; terminated child process.\n")

    completed_at = utc_now()
    attempt = record["attempts"][-1]
    attempt.update({"completed_at": completed_at, "exit_code": exit_code, "timed_out": timed_out})
    signal_name = signal_name_for_exit_code(exit_code)
    if signal_name:
        attempt["signal"] = signal_name

    validation_errors: list[str] = []
    if interrupted_by_keyboard:
        status = INTERRUPTED_STATUS
    elif exit_code == 0:
        validation_errors = validate_repo_after_task(task, repos)
        status = VALIDATION_FAILED_STATUS if validation_errors else (GIT_PENDING_STATUS if args.git_sync else COMPLETE_STATUS)
    elif log_indicates_usage_limit(log_path):
        status = USAGE_LIMIT_STATUS
    elif log_indicates_agent_unavailable(log_path):
        status = AGENT_UNAVAILABLE_STATUS
    elif exit_code < 0:
        status = TERMINATED_STATUS
    else:
        status = FAILED_STATUS

    if validation_errors:
        attempt["validation_errors"] = validation_errors
        record["validation_errors"] = validation_errors
    record.update(
        {
            "status": status,
            "last_completed_at": completed_at,
            "last_exit_code": exit_code,
            "timed_out": timed_out,
        }
    )
    write_state(state_path, state)
    safe_write_progress_markdown(progress_path, tasks, state)

    if interrupted_by_keyboard:
        print(f"[{index}/{total}] Interrupted {task.task_id}; state saved.")
        raise KeyboardInterrupt
    if status == COMPLETE_STATUS:
        print(f"[{index}/{total}] Complete {task.task_id}")
        return True
    if status == GIT_PENDING_STATUS:
        return complete_git_pending_task(task, tasks, index, total, repos, state_dir, state_path, state, progress_path, args)
    if validation_errors:
        print(f"[{index}/{total}] Validation failed for {task.task_id}:")
        for error in validation_errors:
            print(f"  - {error}")
    else:
        print(f"[{index}/{total}] {status} for {task.task_id} (exit={exit_code})")
    return False


def wait_before_retry(
    task: QueueTask,
    tasks: list[QueueTask],
    index: int,
    total: int,
    state_path: Path,
    state: dict[str, Any],
    progress_path: Path,
    status: str,
    delay_seconds: int,
    consecutive_retry: int,
) -> None:
    retry_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=delay_seconds)).isoformat(timespec="seconds")
    record = task_record(state, task)
    if record is not None:
        record["last_retry_status"] = status
        record["consecutive_retries"] = consecutive_retry
        record["retry_delay_seconds"] = delay_seconds
        record["next_retry_at"] = retry_at
        write_state(state_path, state)
        safe_write_progress_markdown(progress_path, tasks, state)
    print(f"[{index}/{total}] {status} for {task.task_id}; retry {consecutive_retry} in {delay_seconds}s.")
    if delay_seconds > 0:
        time.sleep(delay_seconds)


def list_tasks(tasks: list[QueueTask], state: dict[str, Any], show_prompts: bool) -> None:
    upcoming = pending_tasks(tasks, state)
    if not upcoming:
        print("No incomplete tasks.")
        return
    print("Next incomplete tasks:")
    for task in upcoming[:80]:
        phase = f"phase {task.phase_number}" if task.phase_number is not None else "global"
        print(f"- {task.task_id}: {task_status(state, task)}, {phase}, {task.stage}")
        if show_prompts:
            print(indent_text(task.prompt, "  "))
    if len(upcoming) > 80:
        print(f"... {len(upcoming) - 80} more incomplete task(s).")


def indent_text(text: str, prefix: str) -> str:
    return "\n".join(prefix + line for line in text.splitlines())


def validate_setup(plan_path: Path, plan_progress_path: Path, storage_repo: Path) -> None:
    if not plan_path.exists():
        raise RuntimeError(f"Build plan not found: {plan_path}")
    if not storage_repo.exists():
        raise RuntimeError(f"Storage repo not found: {storage_repo}")
    if not plan_progress_path.parent.exists():
        raise RuntimeError(f"Plan progress directory not found: {plan_progress_path.parent}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    storage_repo = args.storage_repo.resolve()
    plan_path = resolve_under_repo(repo_root, args.plan)
    state_dir = resolve_under_repo(repo_root, args.state_dir)
    plan_progress_path = resolve_under_repo(repo_root, args.plan_progress)
    queue_progress_path = resolve_under_repo(repo_root, args.progress) if args.progress else state_dir / "progress.md"
    state_path = state_dir / "state.json"
    lock_path = state_dir / "runner.lock"
    validate_setup(plan_path, plan_progress_path, storage_repo)

    phases = parse_phases(plan_path)
    if not phases:
        raise RuntimeError(f"No phases found in {plan_path}")
    tasks = build_tasks(repo_root, storage_repo, plan_path, plan_progress_path, phases, args)
    if not tasks:
        raise RuntimeError("No queue tasks were built")

    state = load_state(state_path, args, repo_root, storage_repo)
    state.update(
        {
            "agent": args.agent,
            "review_agent": args.review_agent or args.agent,
            "plan_path": str(plan_path),
            "plan_progress_path": str(plan_progress_path),
            "queue_progress_path": str(queue_progress_path),
            "storage_repo": str(storage_repo),
            "review_passes": args.review_passes,
        }
    )
    normalize_stale_running_tasks(tasks, state, state_path)
    print_summary(tasks, state)

    if args.list_only:
        list_tasks(tasks, state, args.show_prompts)
        return 0
    if args.dry_run:
        limit = args.max_runs if args.max_runs > 0 else 25
        print(f"Dry run. Showing up to {limit} incomplete task(s); no agents will be launched.")
        for task in pending_tasks(tasks, state)[:limit]:
            phase = f"phase {task.phase_number}" if task.phase_number is not None else "global"
            print(f"- {task.task_id}: {phase}, {task.stage}")
            if args.show_prompts:
                print(indent_text(task.prompt, "  "))
        return 0

    ok, reason = ensure_agent_health(repo_root, args)
    if not ok:
        print(f"Cannot start queue because the configured mcoda agent is not ready: {reason}")
        return 2

    write_state(state_path, state)
    safe_write_progress_markdown(queue_progress_path, tasks, state)
    repos = repo_map(repo_root, storage_repo)

    attempted = 0
    total = len(tasks)
    reached_max_runs = False
    with RunnerLock(
        lock_path,
        args.ignore_lock,
        args.lock_retry_delay_seconds,
        args.lock_max_wait_seconds,
        args.stale_stopped_lock_seconds,
    ):
        for index, task in enumerate(tasks, start=1):
            consecutive_agent_unavailable = 0
            consecutive_task_failure = 0
            while True:
                status = task_status(state, task)
                if status == COMPLETE_STATUS:
                    break
                if args.max_runs > 0 and attempted >= args.max_runs:
                    print(f"Reached --max-runs={args.max_runs}; stopping.")
                    reached_max_runs = True
                    break
                if status == GIT_PENDING_STATUS:
                    attempted += 1
                    ok = complete_git_pending_task(
                        task,
                        tasks,
                        index,
                        total,
                        repos,
                        state_dir,
                        state_path,
                        state,
                        queue_progress_path,
                        args,
                    )
                else:
                    agent = select_agent_for_task(task, args)
                    if not ensure_agent_usage_available(args, repo_root, state_path, state, agent):
                        safe_write_progress_markdown(queue_progress_path, tasks, state)
                        print(f"Stopping before {task.task_id}: {agent} usage limits are not clear.")
                        return 1
                    attempted += 1
                    ok = run_task(
                        task,
                        tasks,
                        index,
                        total,
                        repo_root,
                        repos,
                        state_dir,
                        state_path,
                        state,
                        queue_progress_path,
                        args,
                    )
                print_summary(tasks, state)
                if ok:
                    break
                stopped_status = task_status(state, task)
                if stopped_status == AGENT_UNAVAILABLE_STATUS and not args.keep_going:
                    consecutive_agent_unavailable += 1
                    if args.agent_unavailable_max_retries > 0 and consecutive_agent_unavailable > args.agent_unavailable_max_retries:
                        print(f"Stopping after {args.agent_unavailable_max_retries} agent retry(s) for {task.task_id}.")
                        return 1
                    wait_before_retry(
                        task,
                        tasks,
                        index,
                        total,
                        state_path,
                        state,
                        queue_progress_path,
                        stopped_status,
                        args.agent_unavailable_retry_delay_seconds,
                        consecutive_agent_unavailable,
                    )
                    continue
                if stopped_status in RETRYABLE_TASK_FAILURE_STATUSES and not args.keep_going:
                    consecutive_task_failure += 1
                    if args.task_failure_max_retries > 0 and consecutive_task_failure > args.task_failure_max_retries:
                        print(f"Stopping after {args.task_failure_max_retries} task retry(s) for {task.task_id}.")
                        return 1
                    wait_before_retry(
                        task,
                        tasks,
                        index,
                        total,
                        state_path,
                        state,
                        queue_progress_path,
                        stopped_status,
                        args.task_failure_retry_delay_seconds,
                        consecutive_task_failure,
                    )
                    continue
                if not args.keep_going:
                    print(f"Stopping after {stopped_status}. Rerun the script to retry from this task.")
                    return 1
                break
            if reached_max_runs:
                break

    remaining = len(pending_tasks(tasks, state))
    if remaining:
        print(f"Stopped with {remaining} incomplete task(s).")
        if reached_max_runs:
            summary = summarize(tasks, state)
            blockers = (
                FAILED_STATUS,
                VALIDATION_FAILED_STATUS,
                GIT_PENDING_STATUS,
                USAGE_LIMIT_STATUS,
                AGENT_UNAVAILABLE_STATUS,
                INTERRUPTED_STATUS,
                TERMINATED_STATUS,
            )
            if not any(summary.get(status, 0) for status in blockers):
                return 0
        return 1 if not args.keep_going else 0
    print("All queue tasks are complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
