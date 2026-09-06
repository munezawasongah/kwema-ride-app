/// Kwema Ride — driver app entry point.
///
/// Run:  flutter run -t lib/main_driver.dart \
///         --dart-define=API_BASE_URL=https://your-api.up.railway.app
///
/// Separate entry point rather than a separate project: the theme,
/// localization, API client, session store and socket layer are identical,
/// and maintaining two copies of those would guarantee they drift.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/auth/auth_controller.dart';
import 'core/l10n/language_controller.dart';
import 'core/l10n/localization.dart';
import 'core/network/api_client.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/login_screen.dart';
import 'features/driver/driver_home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

  // A driver's screen stays on while they work — a phone that sleeps mid-trip
  // means missed offers and a rider left waiting.
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);

  final prefs = await SharedPreferences.getInstance();

  runApp(ProviderScope(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
    child: const KwemaDriverApp(),
  ));
}

class KwemaDriverApp extends ConsumerWidget {
  const KwemaDriverApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeControllerProvider);

    return MaterialApp(
      title: 'Kwema Driver',
      debugShowCheckedModeBanner: false,
      theme: KwemaTheme.light(),
      darkTheme: KwemaTheme.dark(),
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      // Deliberately not const: the Global*Localizations delegates are not
      // const expressions, so a const list here fails to compile.
      localizationsDelegates: <LocalizationsDelegate<dynamic>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: const _DriverGate(),
    );
  }
}

class _DriverGate extends ConsumerWidget {
  const _DriverGate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);

    switch (auth.stage) {
      case AuthStage.checking:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case AuthStage.phoneEntry:
      case AuthStage.codeEntry:
        return const LoginScreen(appName: 'Endesha na Kwema');
      case AuthStage.authenticated:
        // A rider account signing into the driver app is a real support
        // case, so it gets an explicit screen rather than an empty dashboard.
        if (auth.user?.isDriver != true) return const _NotADriverScreen();
        return const DriverHomeScreen();
    }
  }
}

class _NotADriverScreen extends ConsumerWidget {
  const _NotADriverScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.badge_outlined, size: 56),
              const SizedBox(height: 16),
              Text('Akaunti hii si ya dereva',
                  style: Theme.of(context).textTheme.titleLarge,
                  textAlign: TextAlign.center),
              const SizedBox(height: 8),
              const Text(
                'Jisajili kama dereva kwenye kwemaride.co.tz, kisha ingia tena.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: () =>
                    ref.read(authControllerProvider.notifier).signOut(),
                child: const Text('Toka'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
