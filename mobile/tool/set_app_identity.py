#!/usr/bin/env python3
"""Set the Android applicationId and app label for one of the two apps.

Both apps are built from a single Flutter project, so without this they share
a package name — and Android treats same-package installs as an upgrade.
Installing the driver app would silently REPLACE the rider app on the same
handset, which is unusable for a driver who is also a rider, and impossible
for testing both on one phone.

Run before each `flutter build apk`.

Usage: set_app_identity.py <rider|driver>
"""

import re
import sys
from pathlib import Path

IDENTITY = {
    'rider': ('tz.co.kwemaride.rider', 'Kwema Ride'),
    'driver': ('tz.co.kwemaride.driver', 'Kwema Driver'),
}


def patch_gradle(app_id: str) -> bool:
    """Handles both Groovy and Kotlin DSL — Flutter switched to .kts."""
    touched = False
    for name in ('android/app/build.gradle', 'android/app/build.gradle.kts'):
        path = Path(name)
        if not path.exists():
            continue

        text = path.read_text(encoding='utf-8')

        # Groovy:  applicationId "com.example.app"
        # Kotlin:  applicationId = "com.example.app"
        new_text, count = re.subn(
            r'applicationId\s*=?\s*"[^"]*"',
            f'applicationId = "{app_id}"' if name.endswith('.kts')
            else f'applicationId "{app_id}"',
            text,
        )

        if count:
            path.write_text(new_text, encoding='utf-8')
            print(f'  {name}: applicationId -> {app_id}')
            touched = True

    return touched


def patch_label(label: str) -> None:
    path = Path('android/app/src/main/AndroidManifest.xml')
    text = path.read_text(encoding='utf-8')
    text, count = re.subn(r'android:label="[^"]*"', f'android:label="{label}"', text, count=1)
    path.write_text(text, encoding='utf-8')
    print(f'  manifest: label -> {label}' if count else '  manifest: no label found')


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in IDENTITY:
        print('usage: set_app_identity.py <rider|driver>')
        return 1

    app_id, label = IDENTITY[sys.argv[1]]
    print(f'setting identity for {sys.argv[1]}:')

    if not patch_gradle(app_id):
        print('  ERROR: no applicationId found in any build.gradle')
        return 1

    patch_label(label)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
