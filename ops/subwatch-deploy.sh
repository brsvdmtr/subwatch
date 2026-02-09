#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[$(date -Is)] $*"
}

BASE="${BASE:-/opt/subwatch}"

if [[ ! -d "$BASE" ]]; then
  log "ERROR: BASE directory not found: $BASE"
  exit 1
fi

compose_dir=""
compose_file=""

if [[ -f "$BASE/docker-compose.yml" ]]; then
  compose_dir="$BASE"
  compose_file="docker-compose.yml"
elif [[ -f "$BASE/docker-compose.yaml" ]]; then
  compose_dir="$BASE"
  compose_file="docker-compose.yaml"
else
  found="$(find "$BASE" -maxdepth 4 -type f \\( -name docker-compose.yml -o -name docker-compose.yaml \\) -print -quit 2>/dev/null || true)"
  if [[ -z "$found" ]]; then
    log "ERROR: docker-compose.(yml|yaml) not found under $BASE"
    exit 1
  fi
  compose_dir="$(dirname "$found")"
  compose_file="$(basename "$found")"
fi

cd "$compose_dir"
log "Using compose file: $compose_dir/$compose_file"

dc() {
  docker compose -f "$compose_file" "$@"
}

git_ok="false"
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_ok="true"
fi

if [[ "$git_ok" == "true" ]]; then
  remote_name=""
  if git remote get-url origin >/dev/null 2>&1; then
    remote_name="origin"
  else
    remote_name="$(git remote | head -n 1 || true)"
  fi

  if [[ -n "$remote_name" ]]; then
    if [[ -n "$(git status --porcelain)" ]]; then
      log "ERROR: git worktree is dirty; refusing to pull."
      git status --porcelain || true
      exit 1
    fi

    log "Running git pull --ff-only..."
    git pull --ff-only || {
      log "ERROR: git pull failed"
      exit 1
    }
  else
    log "WARN: git repo has no remotes, skipping git pull."
  fi
else
  log "WARN: not a git repo (or git missing), skipping git pull."
fi

if [[ "$git_ok" == "true" ]]; then
  GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
else
  GIT_SHA="unknown"
fi
export GIT_SHA
log "GIT_SHA=$GIT_SHA"

log "Starting infra (postgres, redis)..."
dc up -d postgres redis

if [[ -d "prisma/migrations" ]] && find prisma/migrations -maxdepth 2 -name migration.sql -print -quit >/dev/null 2>&1; then
  log "Running prisma migrate deploy..."
  dc run --rm app npx prisma migrate deploy || {
    log "ERROR: prisma migrate deploy failed"
    exit 1
  }
else
  log "No prisma migrations found, skipping migrate deploy."
fi

log "Building and starting app..."
dc up -d --build app

log "Compose status:"
dc ps || true

log "Health check:"
curl -fsS http://127.0.0.1:3000/health || true

