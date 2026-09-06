/// Language selection — controller, persistence, and the picker UI.
///
/// Resolution order when the app first launches:
///   1. A previously saved choice.
///   2. The device locale, if it is one of the three we support.
///   3. Swahili.
///
/// Note the third step. The usual pattern is to fall back to English, but the
/// overwhelming majority of handsets in this market ship with an English
/// system locale regardless of what their owner actually speaks. Defaulting
/// to the device locale alone would hand almost everyone an English app.
/// Swahili is the honest default; English is a choice, not an accident.
///
/// The choice is written locally first and pushed to the server afterwards.
/// Local write is what the UI reads, so switching language is instant even
/// with no signal; the server copy exists so OTP messages and push
/// notifications arrive in the right language.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'dart:async';

import '../network/api_client.dart';
import 'localization.dart';

const _prefsKey = 'app_language_code';

class LocaleController extends StateNotifier<Locale> {
  LocaleController(this._prefs, this._api)
      : super(_resolveInitial(_prefs).locale);

  final SharedPreferences _prefs;
  final ApiClient _api;

  AppLanguage get language => AppLanguage.fromCode(state.languageCode);

  static AppLanguage _resolveInitial(SharedPreferences prefs) {
    final saved = prefs.getString(_prefsKey);
    if (saved != null) return AppLanguage.fromCode(saved);

    final deviceCode =
        WidgetsBinding.instance.platformDispatcher.locales.first.languageCode;

    // Only honour the device locale when it is Swahili or French. An English
    // device locale is nearly always a factory default here, not a statement
    // of preference — see the note at the top of this file.
    if (deviceCode == 'sw' || deviceCode == 'fr') {
      return AppLanguage.fromCode(deviceCode);
    }
    return AppLanguage.swahili;
  }

  Future<void> change(AppLanguage language) async {
    if (language.locale.languageCode == state.languageCode) return;

    state = language.locale;
    await _prefs.setString(_prefsKey, language.code);

    // Best effort. A failure here means notifications stay in the old
    // language until the next successful sync — not worth blocking the UI or
    // showing an error for.
    unawaited(_api.patch('/users/me/language', {'language': language.code}));
  }
}

final localeControllerProvider =
    StateNotifierProvider<LocaleController, Locale>((ref) {
  return LocaleController(
    ref.watch(sharedPreferencesProvider),
    ref.watch(apiClientProvider),
  );
});

// =====================================================================
// Picker
// =====================================================================

/// Compact switcher for the app bar: a single pill showing the active
/// language's two-letter code. Tapping opens the full sheet.
class LanguagePill extends ConsumerWidget {
  const LanguagePill({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeControllerProvider);
    final language = AppLanguage.fromCode(locale.languageCode);
    final theme = Theme.of(context);

    return Semantics(
      button: true,
      label: AppLocalizations.of(context).translate('settings.choose_language'),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: () => LanguageSheet.show(context),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border.all(color: theme.colorScheme.outline),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.language,
                  size: 16, color: theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 6),
              Text(
                language.short,
                style: theme.textTheme.labelLarge
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Full-width picker. Each language is written in itself, so someone who
/// cannot read the current interface language can still find their own.
class LanguageSheet extends ConsumerWidget {
  const LanguageSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet(
        context: context,
        showDragHandle: true,
        builder: (_) => const LanguageSheet(),
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeControllerProvider);
    final active = AppLanguage.fromCode(locale.languageCode);
    final theme = Theme.of(context);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              AppLocalizations.of(context).translate('settings.choose_language'),
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            ...AppLanguage.values.map((language) {
              final selected = language == active;
              return Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () async {
                    await ref
                        .read(localeControllerProvider.notifier)
                        .change(language);
                    if (context.mounted) Navigator.of(context).pop();
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 16, vertical: 18),
                    decoration: BoxDecoration(
                      color: selected
                          ? theme.colorScheme.primaryContainer
                          : theme.colorScheme.surface,
                      border: Border.all(
                        color: selected
                            ? theme.colorScheme.primary
                            : theme.colorScheme.outline,
                        width: selected ? 2 : 1,
                      ),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 38,
                          height: 38,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: selected
                                ? theme.colorScheme.primary
                                : theme.colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Text(
                            language.short,
                            style: theme.textTheme.labelLarge?.copyWith(
                              fontWeight: FontWeight.w700,
                              color: selected
                                  ? theme.colorScheme.onPrimary
                                  : theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(
                            language.label,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight:
                                  selected ? FontWeight.w700 : FontWeight.w500,
                            ),
                          ),
                        ),
                        if (selected)
                          Icon(Icons.check_circle,
                              color: theme.colorScheme.primary, size: 24),
                      ],
                    ),
                  ),
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}
