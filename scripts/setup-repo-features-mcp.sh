#!/bin/bash
# Setup script for repo-features-mcp-pro MCP server integration with Dyad
#
# This configures the Repo Features MCP Pro server as an MCP server in Dyad,
# providing 21 repository intelligence tools:
#   - Git analysis (status, log, diff, blame, branches, churn)
#   - Code structure (per-file LOC/function/class metrics, 24 languages)
#   - Python AST (stdlib-backed function/class extraction)
#   - TypeScript/JS AST (export/class/interface/type extraction)
#   - GitHub REST (issues, PRs, files, reviews, releases, search)
#   - Hotspot scoring (complexity × churn frequency)
#
# Usage:
#   chmod +x scripts/setup-repo-features-mcp.sh
#   ./scripts/setup-repo-features-mcp.sh

set -euo pipefail

MCP_SERVER_PATH="/Users/cb/Downloads/repo-features-mcp-pro"
VENV_PYTHON="${MCP_SERVER_PATH}/.venv/bin/python"

# Check prerequisites
if [ ! -f "$VENV_PYTHON" ]; then
  echo "ERROR: Python venv not found at $VENV_PYTHON"
  echo "Run: cd $MCP_SERVER_PATH && uv sync"
  exit 1
fi

if [ ! -f "${MCP_SERVER_PATH}/src/server.py" ]; then
  echo "ERROR: server.py not found at ${MCP_SERVER_PATH}/src/server.py"
  exit 1
fi

# Check that the venv has mcp installed
if ! "$VENV_PYTHON" -c "import mcp" 2>/dev/null; then
  echo "ERROR: mcp package not installed in venv"
  echo "Run: cd $MCP_SERVER_PATH && uv sync"
  exit 1
fi

echo "✅ repo-features-mcp-pro found at: $MCP_SERVER_PATH"
echo "✅ Python venv: $VENV_PYTHON"
echo ""
echo "To add this MCP server to Dyad:"
echo ""
echo "1. Open Dyad Settings → MCP Servers"
echo "2. Click 'Add MCP Server'"
echo "3. Configure:"
echo "   Name: repo-features-pro"
echo "   Transport: stdio"
echo "   Command: $VENV_PYTHON"
echo "   Args: [\"-m\", \"src.server\"]"
echo "   Environment Variables:"
echo "     REPO_ROOT = /Users/cb/.openclaw-autoclaw/workspace"
echo "     GITHUB_TOKEN = (your GitHub token, optional)"
echo "     LOG_LEVEL = INFO"
echo "4. Click 'Test Connection'"
echo "5. Enable the server"
echo ""
echo "Available tools (21 total):"
echo "  Git: git_status, git_log, git_diff, git_diff_staged, git_log_file,"
echo "       git_blame, git_branches, git_show"
echo "  Analysis: analyze_repo_structure, analyze_repo_activity, repo_hotspots,"
echo "            python_ast_summary, ts_ast_summary"
echo "  GitHub: github_list_issues, github_list_prs, github_get_issue,"
echo "          github_get_pr, github_pr_files, github_pr_reviews,"
echo "          github_list_releases, github_search_issues"
echo ""
echo "These tools are automatically available to the local agent once configured."
