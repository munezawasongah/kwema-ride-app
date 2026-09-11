#!/usr/bin/env python3
"""Catches unresolved cross-file symbols before they cost a CI build.

`flutter analyze` does this properly, but it needs the SDK. This is a cheap
approximation that catches the single most common mistake when editing Dart
without a toolchain: using a provider, class or enum that lives in another
file without importing it.

It resolves each file's imports transitively through exports, then checks that
every capitalised type and every *Provider identifier it references is either
declared locally or reachable through an import.

Run: python3 tool/check_symbols.py
"""

import re
import sys
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / 'lib'

DECL = re.compile(r'^\s*(?:abstract\s+|sealed\s+|final\s+|base\s+)*'
                  r'(?:class|enum|mixin|extension|typedef)\s+(\w+)', re.M)
TOP_LEVEL = re.compile(r'^(?:final|const)\s+(?:[\w<>,\s?]+\s+)?(\w+)\s*=', re.M)
FUNC = re.compile(r'^(?:[\w<>,\s?]+\s+)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{', re.M)
IMPORT = re.compile(r"import\s+'([^']+)'")
EXPORT = re.compile(r"export\s+'([^']+)'")

# Anything from the SDK or a package; not our problem to resolve.
IGNORE = {
    'Widget', 'BuildContext', 'State', 'Key', 'Color', 'Colors', 'Icon', 'Icons',
    'Text', 'Row', 'Column', 'Container', 'Padding', 'SizedBox', 'Center',
    'Expanded', 'Scaffold', 'AppBar', 'Theme', 'ThemeData', 'TextStyle',
    'EdgeInsets', 'BorderRadius', 'Border', 'BoxDecoration', 'Duration',
    'Timer', 'Future', 'Stream', 'List', 'Map', 'Set', 'String', 'DateTime',
    'Uri', 'Exception', 'Object', 'Buffer', 'Navigator', 'MediaQuery',
    # Riverpod, from package:flutter_riverpod
    'Provider', 'FutureProvider', 'StreamProvider', 'StateProvider',
    'StateNotifierProvider', 'ChangeNotifierProvider', 'NotifierProvider',
    'ProviderScope', 'Consumer', 'ConsumerWidget', 'ConsumerState',
    'ConsumerStatefulWidget', 'WidgetRef', 'StateNotifier', 'AsyncValue',
}


def strip_code(src: str) -> str:
    """Removes comments and string literals so matches are real code."""
    out, i, n = [], 0, len(src)
    s = d = line = block = False
    while i < n:
        c, nxt = src[i], src[i + 1] if i + 1 < n else ''
        if line:
            if c == '\n':
                line = False
                out.append(c)
        elif block:
            if c == '*' and nxt == '/':
                block = False
                i += 1
        elif s:
            if c == '\\':
                i += 1
            elif c == "'":
                s = False
        elif d:
            if c == '\\':
                i += 1
            elif c == '"':
                d = False
        else:
            if c == '/' and nxt == '/':
                line = True
                i += 1
            elif c == '/' and nxt == '*':
                block = True
                i += 1
            elif c == "'":
                s = True
            elif c == '"':
                d = True
            else:
                out.append(c)
        i += 1
    return ''.join(out)


def declared_in(path: Path) -> set:
    src = strip_code(path.read_text(encoding='utf-8'))
    names = set(DECL.findall(src)) | set(TOP_LEVEL.findall(src))
    names |= {n for n in FUNC.findall(src) if n[0].isupper() or n.endswith('Provider')}
    return names


def resolve(path: Path, seen=None) -> set:
    """Everything visible in `path`, following relative imports and exports."""
    if seen is None:
        seen = set()
    if path in seen or not path.exists():
        return set()
    seen.add(path)

    src = path.read_text(encoding='utf-8')
    names = declared_in(path)

    for target in IMPORT.findall(src) + EXPORT.findall(src):
        # Anything that is not package: or dart: is a relative path. Dart does
        # not require a leading ./ for a sibling file, so matching only on '.'
        # silently skipped most of the import graph.
        if target.startswith('package:') or target.startswith('dart:'):
            continue
        resolved = (path.parent / target).resolve()
        names |= resolve(resolved, seen)

    return names


def main() -> int:
    files = sorted(LIB.rglob('*.dart'))
    problems = []

    for f in files:
        src = strip_code(f.read_text(encoding='utf-8'))
        visible = resolve(f)

        used = set(re.findall(r'\b([A-Z]\w+)\b', src))
        used |= set(re.findall(r'\b(\w+Provider)\b', src))

        for name in sorted(used):
            if name in IGNORE or name in visible:
                continue
            # Only flag our own naming conventions; SDK types are endless.
            if name.endswith('Provider') or name.startswith('Kwema'):
                problems.append(f'{f.relative_to(LIB)}: {name} is not imported')

    print(f'{len(files)} files checked')
    if problems:
        print('\nUNRESOLVED:')
        for p in problems:
            print('  -', p)
        return 1
    print('all cross-file symbols resolve')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
