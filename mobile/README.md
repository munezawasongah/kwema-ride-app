# Kwema Ride — mobile apps

One Flutter project, two entry points. The rider and driver apps share the
theme, localization, API client, session store and socket layer; maintaining
two projects would guarantee those drift apart.

```
lib/
├── main_rider.dart          rider entry point
├── main_driver.dart         driver entry point
├── core/
│   ├── auth/                phone + OTP, token lifecycle
│   ├── format/tzs.dart      TZS formatting (no subunit, comma separator)
│   ├── l10n/                Swahili default, English, French
│   ├── location/            offline-first GPS buffer (SQLite, ack-driven)
│   ├── models/              wire models, null-tolerant parsing
│   ├── network/             Dio client, secure session store, Socket.IO
│   └── theme/               tanzanite + marigold palette
└── features/
    ├── auth/                shared login screen
    ├── rider/               home, quoting, live tracking
    └── driver/              dashboard, offer modal, trip lifecycle
```

## First run

```bash
flutter pub get
flutter analyze          # do this first — see the note below
```

Then run whichever app:

```bash
flutter run -t lib/main_rider.dart \
  --dart-define=API_BASE_URL=https://kwema-ride-app-production.up.railway.app

flutter run -t lib/main_driver.dart \
  --dart-define=API_BASE_URL=https://kwema-ride-app-production.up.railway.app
```

`API_BASE_URL` defaults to the Railway deployment, so it can be omitted while
that is the target.

**This code has not been compiled.** Every other part of this project was
typechecked and boot-tested before delivery; the Flutter apps were not,
because the build environment had no Flutter SDK. Expect `flutter analyze` to
surface issues on the first pass — send them over and they get fixed. What
has been verified: balanced delimiters, every relative import resolves, and
every referenced class and provider is defined somewhere in the tree.

## Platform setup

### Android

`android/app/src/main/AndroidManifest.xml` — inside `<application>`:

```xml
<meta-data android:name="com.google.android.geo.API_KEY"
           android:value="YOUR_ANDROID_MAPS_KEY"/>
```

Above `<application>`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<!-- Driver app only: keeps GPS alive when the driver switches to WhatsApp
     or navigation mid-trip. Without it the trip trace has holes, and the
     fare is computed from that trace. -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION"/>
<uses-permission android:name="android.permission.WAKE_LOCK"/>
```

`minSdkVersion 21` or higher in `android/app/build.gradle`.

### iOS

`ios/Runner/AppDelegate.swift`:

```swift
GMSServices.provideAPIKey("YOUR_IOS_MAPS_KEY")
```

`ios/Runner/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Tunahitaji eneo lako ili kukutafutia dereva wa karibu.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Tunahitaji eneo lako ili kufuatilia safari yako.</string>
<key>UIBackgroundModes</key>
<array><string>location</string></array>
```

### Maps keys

Three separate keys, all from the same Google Cloud project:

| Key | Restriction | Used by |
|---|---|---|
| Android | SHA-1 + package name | `google_maps_flutter` on Android |
| iOS | Bundle id | `google_maps_flutter` on iOS |
| Server | API restrictions only | Backend routing, Places, Geocoding |

The apps never call Directions, Places or Geocoding directly — those go
through the backend proxy, so the server key never ships in an APK. APKs get
unpacked, and a Directions-capable key in one is someone else spending your
Maps budget.

## Assets

`assets/vehicles/` is referenced by `pubspec.yaml` but empty. Either add
`boda.png`, `bajaji.png`, `car.png`, `xl.png` and `express.png`, or remove
the `assets:` block — a missing asset directory fails the build. The UI
currently uses coloured bars rather than icons, so removing it is safe.

## Design decisions worth keeping

**Swahili is the default, not the device locale.** Nearly every handset sold
here ships with an English system locale regardless of what its owner speaks,
so following the device would hand almost everyone an English app. French and
Swahili device locales are honoured; English is treated as a factory setting.

**Tokens live in the platform keystore**, not shared preferences. A refresh
token is valid for sixty days and is enough to impersonate the account.

**The driver's offer countdown is derived from the server's absolute expiry**,
not a local fifteen-second tick. A backgrounded app otherwise shows time
remaining on an offer that was reassigned minutes ago.

**Location fixes are deleted only after the server acknowledges the sequence
number.** A two-minute dead zone on the Morogoro road otherwise puts holes in
the trip trace, and the fare is computed from that trace.

**Card fields are never rendered by these apps.** Card payment opens the
provider's hosted 3-D Secure page. Accepting card input here, even to forward
it, would pull the platform into PCI DSS SAQ-D and an annual audit.
