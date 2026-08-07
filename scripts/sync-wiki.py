#!/usr/bin/env python3
"""Sync docs/wiki/ (source of truth) into the GitHub Wiki repo checkout.

Usage: python3 scripts/sync-wiki.py <wiki-repo-dir>

Transformations (GitHub Wiki pages are flat and extension-less):
  - inter-page links `[Text](Bot.md#anchor)` -> `[Text](Bot#anchor)`;
  - links into the main repo (`../../PLAN.md`, `../PROTOCOL.md`, ...) ->
    absolute blob URLs, so they keep working from the Wiki tab;
  - generates `_Sidebar.md` with the page list (Home first).

Idempotent: writing the same content twice produces no git diff.
"""

import pathlib
import re
import sys

BLOB = "https://github.com/ilyanosovsky/reservio-bot/blob/main"
SRC = pathlib.Path(__file__).resolve().parent.parent / "docs" / "wiki"

REPO_MAP = {
    "../../PLAN.md": f"{BLOB}/PLAN.md",
    "../../CLAUDE.md": f"{BLOB}/CLAUDE.md",
    "../../LICENSE": f"{BLOB}/LICENSE",
    "../../README.md": f"{BLOB}/README.md",
    "../PROTOCOL.md": f"{BLOB}/docs/PROTOCOL.md",
    "../supabase-schema.sql": f"{BLOB}/docs/supabase-schema.sql",
}

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    wiki = pathlib.Path(sys.argv[1])
    if not (wiki / ".git").exists():
        print(f"not a git checkout: {wiki}", file=sys.stderr)
        return 2

    pages = sorted(p.stem for p in SRC.glob("*.md"))

    def fix_link(m: re.Match) -> str:
        text, target = m.group(1), m.group(2)
        base = target.split("#")[0]
        anchor = target[len(base):]
        if base in REPO_MAP:
            return f"[{text}]({REPO_MAP[base]}{anchor})"
        name = base.rsplit("/", 1)[-1]
        if name.endswith(".md") and name[:-3] in pages:
            return f"[{text}]({name[:-3]}{anchor})"
        return m.group(0)

    for md in SRC.glob("*.md"):
        content = LINK_RE.sub(fix_link, md.read_text(encoding="utf-8"))
        (wiki / md.name).write_text(content, encoding="utf-8")
        print(f"synced {md.name}")

    ordered = ["Home"] + [p for p in pages if p != "Home"]
    sidebar = "### Pages\n\n" + "\n".join(f"- [[{p}]]" for p in ordered) + "\n"
    (wiki / "_Sidebar.md").write_text(sidebar, encoding="utf-8")
    print("synced _Sidebar.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
