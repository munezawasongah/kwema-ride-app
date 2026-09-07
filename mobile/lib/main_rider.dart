/// Kwema Ride — rider app entry point.
///
/// Run:  flutter run -t lib/main_rider.dart \
///         --dart-define=API_BASE_URL=https://your-api.up.railway.app

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
import 'features/shared/main_shell.dart';
import 'features/rider/rider_home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Portrait only. A rider is holding the phone one-handed at a roadside and
  // a rotating map costs more than it gives.
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

  final prefs = await SharedPreferences.getInstance();

  runApp(ProviderScope(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
    child: const KwemaRiderApp(),
  ));
}

class KwemaRiderApp extends ConsumerWidget {
  const KwemaRiderApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeControllerProvider);

    return MaterialApp(
      title: 'Kwema Ride',
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
      home: const _RiderGate(),
    );
  }
}

class _RiderGate extends ConsumerWidget {
  const _RiderGate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);

    switch (auth.stage) {
      case AuthStage.checking:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case AuthStage.phoneEntry:
      case AuthStage.codeEntry:
        return const LoginScreen(appName: 'Safiri kwa urahisi');
      case AuthStage.authenticated:
        return const MainShell(
          home: RiderHomeScreen(),
          isDriver: false,
        );
    }
  }
}
