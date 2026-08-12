#!/usr/bin/env bash
#
# Local build & deploy script for Toque.
#
# Builds the container image on this machine, pushes it to Cloudflare's
# managed registry, and deploys the Worker — all from your local Docker.
#
# Usage:
#   ./scripts/deploy.sh              # build + push + deploy
#   ./scripts/deploy.sh --dev        # local dev mode (wrangler dev)
#   ./scripts/deploy.sh --build-only # build + push, no deploy
#   ./scripts/deploy.sh --rollback <image>  # deploy existing image
#
# Prerequisites:
#   - Docker (or Colima) running locally
#   - CLOUDFLARE_API_TOKEN env var set (or wrangler login done)
#   - npm dependencies installed (npm ci)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="toque"
TAG="$(git -C "$PROJECT_ROOT" rev-parse --short=7 HEAD 2>/dev/null || echo "local")"
WRANGLER_CONFIG="$PROJECT_ROOT/wrangler.jsonc"

cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo -e "\033[1;34m▶\033[0m $*"; }
ok()   { echo -e "\033[1;32m✓\033[0m $*"; }
err()  { echo -e "\033[1;31m✗\033[0m $*" >&2; }
die()  { err "$*"; exit 1; }

check_docker() {
  log "Checking Docker..."
  if ! docker info >/dev/null 2>&1; then
    die "Docker is not running. Start Docker (or Colima) and retry."
  fi
  ok "Docker is running"
}

check_deps() {
  command -v npx >/dev/null 2>&1 || die "npx not found. Install Node.js first."
  [ -f "$WRANGLER_CONFIG" ] || die "wrangler.jsonc not found at $WRANGLER_CONFIG"
}

# Patch wrangler.jsonc: set the container image field
set_image() {
  local image_ref="$1"
  log "Patching wrangler.jsonc with image: $image_ref"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const raw = fs.readFileSync(path, "utf8");
    // Strip JSONC comments safely — only remove // and /* */ that are NOT
    // inside string literals. Walk the string char-by-char tracking whether
    // we are inside a double-quoted string. Also remove trailing commas
    // left behind when comment-only lines are stripped (JSONC allows them,
    // JSON does not).
    let inString = false;
    let escape = false;
    let stripped = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (escape) { stripped += ch; escape = false; continue; }
      if (ch === "\\" && inString) { stripped += ch; escape = true; continue; }
      if (ch === "\"") { inString = !inString; stripped += ch; continue; }
      if (!inString && ch === "/" && next === "/") {
        // line comment — skip to end of line (but keep the newline)
        while (i < raw.length && raw[i] !== "\n") i++;
        continue;
      }
      if (!inString && ch === "/" && next === "*") {
        // block comment — skip to closing */
        i += 2;
        while (i < raw.length - 1 && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
        i++; // skip the */
        continue;
      }
      stripped += ch;
    }
    // Remove trailing commas: a comma followed by only whitespace and then
    // a closing } or ] is invalid JSON and must be removed.
    stripped = stripped.replace(/,(\s*[\]}])/g, "$1");
    const json = JSON.parse(stripped);
    if (!json.containers || !json.containers[0]) throw new Error("No container config in wrangler.jsonc");
    json.containers[0].image = process.argv[2];
    fs.writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  ' "$WRANGLER_CONFIG" "$image_ref"
  ok "wrangler.jsonc updated"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
do_build_and_push() {
  check_docker
  check_deps

  local full_tag="${IMAGE_NAME}:${TAG}"
  log "Building and pushing image: $full_tag"

  # Build from Dockerfile (Node.js 26 slim + headless browser deps for
  # CloakBrowser). wrangler containers build doesn't support --dockerfile,
  # so we use docker build directly with -f, then push to Cloudflare's
  # managed registry.
  docker build -f Dockerfile -t "$full_tag" . 2>&1 | tee /dev/stderr

  local account_id
  account_id=$(npx wrangler whoami 2>/dev/null | grep -oE '[a-f0-9]{32}' | head -1)
  local registry_uri="registry.cloudflare.com/${account_id}/${full_tag}"

  if [ -z "$account_id" ]; then
    die "Could not determine account ID. Check the build log above."
  fi

  # Authenticate to the Cloudflare registry (temporary token, valid ~15 min)
  local registry_token
  registry_token=$(npx wrangler containers registries credentials registry.cloudflare.com --push 2>/dev/null | tail -1)
  echo "$registry_token" | docker login registry.cloudflare.com -u v1 --password-stdin 2>&1 | tee /dev/stderr

  # Tag for the Cloudflare registry and push
  docker tag "$full_tag" "$registry_uri" 2>&1 | tee /dev/stderr
  docker push "$registry_uri" 2>&1 | tee /dev/stderr

  ok "Image pushed to: $registry_uri"
  echo "$registry_uri" > "$PROJECT_ROOT/.last-image"
  set_image "$registry_uri"
}

do_deploy() {
  check_deps
  log "Deploying Worker to Cloudflare..."
  npx wrangler deploy
  ok "Deployed successfully"
}

do_dev() {
  check_docker
  check_deps
  log "Starting local dev session (wrangler dev)..."
  npx wrangler dev
}

do_rollback() {
  local image="$1"
  [ -z "$image" ] && die "Usage: ./scripts/deploy.sh --rollback <image>"
  log "Rolling back to image: $image"
  set_image "$image"
  do_deploy
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
MODE="deploy"
ROLLBACK_IMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)         MODE="dev"; shift ;;
    --build-only)  MODE="build"; shift ;;
    --rollback)    MODE="rollback"; ROLLBACK_IMAGE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

case "$MODE" in
  build)
    do_build_and_push
    ok "Build-only complete. Run ./scripts/deploy.sh to deploy."
    ;;
  deploy)
    do_build_and_push
    do_deploy
    ok "Full deploy complete."
    ;;
  dev)
    do_dev
    ;;
  rollback)
    do_rollback "$ROLLBACK_IMAGE"
    ;;
esac
