#!/usr/bin/env bash
#
# ProxAI Gateway installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://github.com/proxai/proxai_gateway/raw/main/install.sh | bash
#
# Environment variables:
#   PROXAI_GATEWAY_VERSION  Pin to a specific release tag (e.g. "v2026.5.7").
#                           Defaults to "latest".

set -euo pipefail

REPO="proxai/proxai_gateway"
INSTALL_DIR="${HOME}/.proxai/bin"
BINARY_NAME="proxai-gateway"
VERSION="${PROXAI_GATEWAY_VERSION:-latest}"

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "${uname_s}" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) err "unsupported operating system: ${uname_s} (use install.ps1 on Windows)" ;;
  esac
}

detect_arch() {
  local uname_m
  uname_m="$(uname -m)"
  case "${uname_m}" in
    arm64 | aarch64) echo "arm64" ;;
    x86_64 | amd64) echo "x64" ;;
    *) err "unsupported architecture: ${uname_m}" ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "required command not found: $1"
}

download() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL --retry 3 -o "${dest}" "${url}"; then
      err "download failed: ${url} (release may not exist yet for ${VERSION})"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q -O "${dest}" "${url}"; then
      err "download failed: ${url} (release may not exist yet for ${VERSION})"
    fi
  else
    err "neither curl nor wget is available"
  fi
}

update_path_in_rc() {
  local rc_file="$1"
  local marker='# Added by ProxAI Gateway installer'
  local line="export PATH=\"\$HOME/.proxai/bin:\$PATH\""

  [ -f "${rc_file}" ] || return 0

  if grep -Fq "${INSTALL_DIR}" "${rc_file}" 2>/dev/null; then
    return 0
  fi

  {
    printf '\n%s\n' "${marker}"
    printf '%s\n' "${line}"
  } >>"${rc_file}"

  info "updated ${rc_file} to add ${INSTALL_DIR} to PATH"
}

main() {
  require_cmd uname
  require_cmd mkdir
  require_cmd chmod

  local os arch url path_segment
  os="$(detect_os)"
  arch="$(detect_arch)"

  if [ "${os}" = "darwin" ] && [ "${arch}" = "x64" ]; then
    cat >&2 <<'EOF'
error: Intel Mac (darwin-x64) is not supported by the prebuilt binary distribution.
       Apple Silicon (arm64) Macs only.

To build a darwin-x64 binary manually:
  git clone https://github.com/proxai/proxai_gateway
  cd proxai_gateway && bun install && bun run build:darwin-x64
EOF
    exit 1
  fi

  if [ "${VERSION}" = "latest" ]; then
    path_segment="latest/download"
  else
    path_segment="download/${VERSION}"
  fi

  url="https://github.com/${REPO}/releases/${path_segment}/${BINARY_NAME}-${os}-${arch}"

  info "installing ProxAI Gateway (${os}-${arch}, ${VERSION})"
  info "source: ${url}"

  mkdir -p "${INSTALL_DIR}"

  local dest="${INSTALL_DIR}/${BINARY_NAME}"
  local tmp
  tmp="$(mktemp "${INSTALL_DIR}/.${BINARY_NAME}.XXXXXX")"

  trap 'rm -f "${tmp}"' EXIT

  download "${url}" "${tmp}"
  chmod +x "${tmp}"
  mv -f "${tmp}" "${dest}"
  trap - EXIT

  info "installed ${dest}"

  case "${SHELL:-}" in
    *zsh) update_path_in_rc "${HOME}/.zshrc" ;;
    *bash)
      update_path_in_rc "${HOME}/.bashrc"
      update_path_in_rc "${HOME}/.bash_profile"
      ;;
    *)
      update_path_in_rc "${HOME}/.zshrc"
      update_path_in_rc "${HOME}/.bashrc"
      ;;
  esac

  info ""
  info "ProxAI Gateway installed."

  local cfg="${HOME}/.proxai/proxai-gateway/config.toml"
  if [ -f "${cfg}" ]; then
    info "Existing configuration detected; reconciling daemon state..."
    "${dest}" setup || info "Run '${BINARY_NAME} status' for details."
  else
    info "Restart your shell, then run: ${BINARY_NAME} setup"
  fi
}

main "$@"
