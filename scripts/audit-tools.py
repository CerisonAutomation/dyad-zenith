#!/usr/bin/env python3
"""Tool-failure analytics from the Dyad chat DB."""
import re
import sqlite3
import sys
from collections import Counter

DB = sys.argv[1] if len(sys.argv) > 1 else (
    __import__("os").path.expanduser("~/Library/Application Support/dyad/sqlite.db")
)

TOOL_RE = re.compile(
    r"(rebuild_app|restart_app|execute_sandbox_script|search_replace|"
    r"read_file|add_dependency|execute_sql|read_guide|update_todos|exit_plan)"
)

db = sqlite3.connect(DB)
tools: Counter[str] = Counter()
chats: Counter[int] = Counter()
for cid, content in db.execute("SELECT chat_id, content FROM messages"):
    if not content:
        continue
    for m in TOOL_RE.finditer(content):
        tools[m.group(1)] += 1
        chats[cid] += 1

print("── Tool usage across chats:")
for tool, n in tools.most_common():
    print(f"   {tool}: {n}")
print(f"── Chats with tool calls: {len(chats)}")
