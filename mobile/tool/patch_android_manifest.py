#!/usr/bin/env python3
"""Inject the Maps SDK key and required permissions into AndroidManifest.xml.

Run after `flutter create` regenerates the android/ folder. Idempotent — safe
to run repeatedly, which matters because CI regenerates the platform files on
every build.

Usage: patch_android_manifest.py <manifest-path> <maps-api-key>

The key passed here is the *Android-restricted* Maps key (SHA-1 + package
name). The server key must never reach an APK: APKs get unpacked, and a
Directions-capable key inside one is someone else spending the Maps budget.
"""

import re
import sys

PERMISSIONS = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    # Driver app: keeps GPS alive when the driver switches to WhatsApp or
    # navigation mid-trip. Without it the breadcrumb trail has holes, and the
    # fare is computed from that trail.
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.WAKE_LOCK',
]


def main() -> int:
    if len(sys.argv) < 3:
        print('usage: patch_android_manifest.py <manifest> <maps-key>')
        return 1

    path, key = sys.argv[1], sys.argv[2]

    with open(path, encoding='utf-8') as handle:
        xml = handle.read()

    added_permissions = []
    block = ''
    for permission in PERMISSIONS:
        if permission not in xml:
            block += f'    <uses-permission android:name="{permission}"/>\n'
            added_permissions.append(permission.rsplit('.', 1)[-1])

    if block:
        xml = re.sub(r'(<manifest[^>]*>)', r'\1\n' + block.rstrip(), xml, count=1)

    if 'com.google.android.geo.API_KEY' in xml:
        # Replace the existing value rather than adding a second meta-data
        # element, which would make the merged manifest ambiguous.
        xml = re.sub(
            r'(<meta-data\s+android:name="com\.google\.android\.geo\.API_KEY"\s+'
            r'android:value=")[^"]*(")',
            r'\g<1>' + key + r'\g<2>',
            xml,
        )
        key_action = 'replaced'
    else:
        meta = (
            f'\n        <meta-data android:name="com.google.android.geo.API_KEY"\n'
            f'            android:value="{key}"/>'
        )
        xml = re.sub(r'(<application[^>]*>)', r'\1' + meta, xml, count=1)
        key_action = 'inserted'

    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(xml)

    print(f'maps key {key_action}')
    print(f'permissions added: {", ".join(added_permissions) or "none (already present)"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
