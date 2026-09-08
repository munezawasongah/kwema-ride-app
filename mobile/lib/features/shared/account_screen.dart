/// Account: profile, language, and sign out.
///
/// Deliberately sparse. The useful things a rider or driver actually needs
/// here are their number, their rating, the language switch, and a way out.
/// Everything else is settings clutter on a phone that may be someone's only
/// device.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/format/tzs.dart';
import '../../core/l10n/language_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../driver/driver_controller.dart';

final profileProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get('/users/me');
  return (res as Map).cast<String, dynamic>();
});

Future<void> _editName(
    BuildContext context, WidgetRef ref, String current) async {
  final controller = TextEditingController(text: current);
  final l10n = AppLocalizations.of(context);

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(
        left: 24, right: 24, top: 8,
        bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.translate('account.edit_name'),
              style: Theme.of(sheetContext)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          TextField(
            controller: controller,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            maxLength: 120,
            decoration: InputDecoration(
              hintText: l10n.translate('auth.name_placeholder'),
              counterText: '',
              prefixIcon: const Icon(Icons.person_outline),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 56,
            child: FilledButton(
              onPressed: () async {
                await ref
                    .read(authControllerProvider.notifier)
                    .saveName(controller.text);
                if (sheetContext.mounted) Navigator.of(sheetContext).pop();
              },
              child: Text(l10n.translate('account.save')),
            ),
          ),
        ],
      ),
    ),
  );
  controller.dispose();
}

class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key, this.isDriver = false});
  final bool isDriver;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final profile = ref.watch(profileProvider);
    final auth = ref.watch(authControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.translate('nav.account'))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // The whole card is tappable. A name that can only be set once, at
          // signup, means a typo is permanent and visible to every driver.
          InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => _editName(context, ref, auth.user?.fullName ?? ''),
            child: Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(children: [
              CircleAvatar(
                radius: 28,
                backgroundColor: theme.colorScheme.primary,
                child: Text(
                  (auth.user?.fullName.isNotEmpty ?? false)
                      ? auth.user!.fullName.substring(0, 1).toUpperCase()
                      : '?',
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 22,
                      fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      (auth.user?.fullName.trim().isNotEmpty ?? false)
                          ? auth.user!.fullName
                          : l10n.translate('auth.name_placeholder'),
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: (auth.user?.fullName.trim().isNotEmpty ?? false)
                            ? null
                            : theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    Text(auth.user?.phone ?? '',
                        style: theme.textTheme.bodyMedium),
                    profile.maybeWhen(
                      data: (p) => Text(
                        '★ ${(p['rating'] as num? ?? 5).toStringAsFixed(1)}'
                        '  ·  ${p['ratingCount'] ?? 0}',
                        style: theme.textTheme.bodySmall,
                      ),
                      orElse: () => const SizedBox.shrink(),
                    ),
                  ],
                ),
              ),
              Icon(Icons.edit_outlined,
                  size: 20, color: theme.colorScheme.onSurfaceVariant),
            ]),
            ),
          ),

          // Drivers see their commission position here. A driver should watch
          // it building rather than discover it when offers stop arriving.
          if (isDriver) ...[
            const SizedBox(height: 16),
            Consumer(builder: (context, ref, _) {
              final wallet = ref.watch(driverControllerProvider);
              if (wallet.debtCents == 0) return const SizedBox.shrink();
              return Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: wallet.isBlocked
                      ? theme.colorScheme.error.withValues(alpha: 0.10)
                      : KwemaColors.marigold50,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(l10n.translate('account.commission_owed'),
                        style: theme.textTheme.bodySmall),
                    Text(formatTzs(wallet.debtCents),
                        style: theme.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          color: wallet.isBlocked
                              ? theme.colorScheme.error
                              : KwemaColors.marigold700,
                        )),
                    Text(
                      l10n.translate('account.commission_limit', params: {
                        'amount': formatTzs(wallet.debtCeilingCents),
                      }),
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              );
            }),
          ],

          const SizedBox(height: 24),
          Text(l10n.translate('settings.language'),
              style: theme.textTheme.titleSmall
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          const SizedBox(height: 8),
          Card(
            child: ListTile(
              leading: const Icon(Icons.language),
              title: Text(ref.watch(localeControllerProvider).languageCode == 'sw'
                  ? 'Kiswahili'
                  : ref.watch(localeControllerProvider).languageCode == 'fr'
                      ? 'Français'
                      : 'English'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => LanguageSheet.show(context),
            ),
          ),

          const SizedBox(height: 24),
          OutlinedButton.icon(
            icon: const Icon(Icons.logout),
            label: Text(l10n.translate('account.sign_out')),
            style: OutlinedButton.styleFrom(
                foregroundColor: theme.colorScheme.error),
            onPressed: () => ref.read(authControllerProvider.notifier).signOut(),
          ),

          const SizedBox(height: 32),
          Center(
            child: Column(children: [
              Text('Kwema Ride  ·  v0.1.0', style: theme.textTheme.bodySmall),
              const SizedBox(height: 2),
              Text('© 2026 Jatelo Technologies',
                  style: theme.textTheme.bodySmall),
            ]),
          ),
        ],
      ),
    );
  }
}
