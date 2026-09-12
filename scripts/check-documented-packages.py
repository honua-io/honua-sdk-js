#!/usr/bin/env python3
"""Prove every package a documentation page tells a reader to install resolves.

A quickstart is only true if its commands run. The commands that fail most
quietly are the install lines: `npx honua-plugin-certify` looks right, and fails
for a reader who has not already installed the SDK, because npx resolves the
argument as a *package* name and no package by that name exists. The same shape
catches renamed packages, packages that were documented before they were
published, and scoped packages typed without their scope.

This walks the OKF bundle, extracts every install command, and asks the
registry. It is deliberately a scheduled gate rather than a per-pull-request
one: it talks to npm, PyPI and nuget.org, and a registry outage is not a reason
to block a merge.

Exit codes: 0 every documented package resolves, 1 at least one does not,
2 the run could not be completed (network, bad manifest).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPO_ROOT / "docs" / "okf-bundle.v1.json"

# Commands that name a package to fetch. `npx -p <pkg> <bin>` is matched by the
# npx pattern's first alternative; a bare `npx <name>` is matched by the second
# and is exactly the case worth catching.
# `npm install` and `pip install` take any number of packages, so these capture
# the whole argument tail and every name in it is checked. Capturing only the
# first positional argument would let a typo or an unpublished package anywhere
# after it sit behind a green gate - `npm install @honua/sdk-js @honua/react
# react react-dom maplibre-gl` would have proven one name out of five.
MULTI_PATTERNS = (
    ("pypi", re.compile(r"\bpip3? install ([^\n#|;&]+)")),
    ("npm", re.compile(r"\bnpm (?:install|i|add) ([^\n#|;&]+)")),
)

# These take exactly one package, so the single capture is correct.
PATTERNS = (
    ("npm", re.compile(r"\bnpx (?:-y |--yes )?(?:-p |--package[= ])?((?:@[\w.-]+/)?[\w.-]+)")),
    ("nuget", re.compile(r"\bdotnet add package ([\w.]+)")),
)

# A package name, optionally scoped. Anchored, so a path or URL argument does
# not slip through as a registry lookup.
PACKAGE_NAME = re.compile(r"^(?:@[\w.-]+/)?[A-Za-z][\w.-]*$")
NOT_A_PACKAGE_PREFIX = ("./", "../", "/", "http://", "https://", "git+", "file:", "~")


def package_names(tail: str) -> list[str]:
    """Every package named in an install command's argument tail.

    Flags are dropped, as are paths and URLs - `npm install ./local-copy` is a
    real command but not a registry claim. A version or tag suffix is stripped,
    because the gate asks whether the package resolves at all; `pkg@next` and
    `pkg` are the same question here.
    """
    names = []
    for token in tail.split():
        if token.startswith("-") or token.startswith(NOT_A_PACKAGE_PREFIX):
            continue
        name = token
        # Strip the version/tag, keeping a leading scope: @scope/pkg@1.2.3.
        at = name.find("@", 1 if name.startswith("@") else 0)
        if name.startswith("@"):
            slash = name.find("/")
            at = name.find("@", slash) if slash != -1 else -1
        if at > 0:
            name = name[:at]
        # pip extras and version specifiers: pkg[extra], pkg>=1.0
        name = re.split(r"[\[<>=!~;]", name, maxsplit=1)[0].strip()
        if name and PACKAGE_NAME.match(name):
            names.append(name)
    return names

# Packages a reader is told to install from somewhere other than the public
# registry, or that are not packages at all. Each needs a reason; the point of
# the gate is that "it 404s and that is fine" has to be written down.
ALLOWED = {
    "npm:honua-js-migrate": "A bin inside @honua/honua-migrate. Documented behind an explicit `npm install` of that package, so the local bin resolves.",
}


def load_pages() -> list[pathlib.Path]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    root = REPO_ROOT / manifest["root"]
    ex_dirs = {(REPO_ROOT / e["path"]).resolve() for e in manifest.get("excludedDirs", [])}
    ex_files = {(REPO_ROOT / e["path"]).resolve() for e in manifest.get("excludedFiles", [])}
    pages = []
    for path in sorted(root.rglob("*.md")):
        resolved = path.resolve()
        if resolved in ex_files or any(p in ex_dirs for p in resolved.parents):
            continue
        pages.append(path)
    readme = REPO_ROOT / "README.md"
    if readme.is_file():
        pages.append(readme)
    return pages


FENCE_RE = re.compile(r"^(?:```|~~~)", re.M)


def code_blocks(text: str) -> str:
    """Return only the fenced code in a page.

    A command a reader runs lives in a code block. Prose that *names* a command
    - "a bare `npx honua-plugin-certify` fails to resolve" - is the opposite of
    a defect, and matching it would make the page that documents the trap fail
    the gate that exists because of it.
    """
    parts = FENCE_RE.split(text)
    return chr(10).join(parts[1::2])


def extract(pages: list[pathlib.Path]) -> dict[tuple[str, str], set[str]]:
    found: dict[tuple[str, str], set[str]] = {}
    for path in pages:
        text = code_blocks(path.read_text(encoding="utf-8", errors="replace"))
        rel = path.relative_to(REPO_ROOT).as_posix()
        for registry, pattern in MULTI_PATTERNS:
            for tail in pattern.findall(text):
                for name in package_names(tail):
                    found.setdefault((registry, name), set()).add(rel)
        for registry, pattern in PATTERNS:
            for name in pattern.findall(text):
                if name.startswith("-") or name in {"install", "run", "-y"}:
                    continue
                found.setdefault((registry, name), set()).add(rel)
    return found


def url_for(registry: str, name: str) -> str:
    if registry == "pypi":
        return f"https://pypi.org/pypi/{name}/json"
    if registry == "npm":
        return f"https://registry.npmjs.org/{name.replace('/', '%2f')}"
    return f"https://api.nuget.org/v3-flatcontainer/{name.lower()}/index.json"


def resolve(item: tuple[str, str]) -> tuple[str, str, int | None, str]:
    registry, name = item
    request = urllib.request.Request(
        url_for(registry, name), headers={"User-Agent": "honua-docs-package-gate"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return registry, name, response.status, ""
    except urllib.error.HTTPError as error:
        return registry, name, error.code, ""
    except Exception as error:  # network, DNS, TLS
        return registry, name, None, str(error)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="print what was found and exit")
    args = parser.parse_args(argv)

    found = extract(load_pages())
    if args.list:
        for (registry, name), where in sorted(found.items()):
            print(f"{registry:6} {name:<34} {len(where)} page(s)")
        return 0

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(resolve, found))

    unreachable = [r for r in results if r[2] is None]
    if unreachable:
        for registry, name, _, why in unreachable:
            print(f"could not reach the {registry} registry for {name}: {why}", file=sys.stderr)
        print("::warning::registry unreachable; treating as inconclusive", file=sys.stderr)
        return 2

    broken = []
    for registry, name, status, _ in sorted(results):
        key = f"{registry}:{name}"
        if status == 200:
            continue
        if key in ALLOWED:
            print(f"allowed  {key} ({status}): {ALLOWED[key]}")
            continue
        broken.append((registry, name, status))

    if broken:
        print("::error::documentation tells readers to install packages that do not resolve:", file=sys.stderr)
        for registry, name, status in broken:
            pages = ", ".join(sorted(found[(registry, name)]))
            print(f"  {registry} {name} -> HTTP {status}\n      cited by: {pages}", file=sys.stderr)
        print(
            "\nEither publish it, correct the command, or add it to ALLOWED in this "
            "script with the reason it cannot resolve.",
            file=sys.stderr,
        )
        return 1

    print(f"All {len(results)} documented package reference(s) resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
