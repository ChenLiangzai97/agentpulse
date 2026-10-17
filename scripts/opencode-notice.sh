# >>> agentpulse-opencode-notice
# Detection only. Never execute OpenCode, source shell configuration, or import data.
(
  ap_opencode_db="${AGENTPULSE_OPENCODE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}"
  if command -v opencode >/dev/null 2>&1 || [ -e "$ap_opencode_db" ]; then
    printf '\n%s\n' 'OpenCode detected (observe-only; no hooks or control channel installed).'
    printf '  Database for this installer account: %s\n' "$ap_opencode_db"
    printf '%s\n' '  In the AgentPulse checkout, check without importing:' \
      '    bun scripts/observe-opencode.ts --check' \
      '  To enable, persist AGENTPULSE_OPENCODE_ENABLED=true in the AgentPulse SERVER environment and restart it.' \
      '  For a custom path, also persist AGENTPULSE_OPENCODE_DB=/absolute/path/to/opencode.db.' \
      '  The server account must be able to read the source DB and its WAL files.' \
      '  First import includes all historical sessions, including archives; there is no session-count cap.' \
      '  A remote relay/supervisor cannot expose this local DB to the central server.' \
      '  No observation setting was changed. See docs/OPENCODE.md for setup and compatibility.'
  fi
)
# <<< agentpulse-opencode-notice
