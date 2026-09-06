/// Phone and code entry, used by both apps.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/l10n/language_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key, required this.appName});
  final String appName;

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phone = TextEditingController(text: '+255');
  final _code = TextEditingController();

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(actions: const [
        Padding(padding: EdgeInsets.only(right: 16), child: LanguagePill()),
      ]),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Kwema',
                  style: theme.textTheme.displaySmall?.copyWith(
                    color: theme.colorScheme.primary,
                    fontWeight: FontWeight.w800,
                  )),
              Text(widget.appName, style: theme.textTheme.bodyLarge),
              const SizedBox(height: 40),

              if (auth.stage == AuthStage.codeEntry) ..._codeEntry(l10n, auth)
              else ..._phoneEntry(l10n, auth),

              if (auth.error != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.error.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    l10n.translate(auth.error!,
                        params: {'n': '${auth.resendAfter}'}),
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _phoneEntry(AppLocalizations l10n, AuthState auth) => [
        Text(l10n.translate('auth.phone_label'),
            style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9+]')),
            LengthLimitingTextInputFormatter(13),
          ],
          style: const TextStyle(fontSize: 20, letterSpacing: 1),
          decoration: const InputDecoration(hintText: '+255XXXXXXXXX'),
        ),
        const SizedBox(height: 10),
        Text(l10n.translate('auth.phone_hint'),
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: auth.busy
              ? null
              : () => ref
                  .read(authControllerProvider.notifier)
                  .requestCode(_phone.text.trim()),
          child: auth.busy
              ? const SizedBox(
                  width: 22, height: 22,
                  child: CircularProgressIndicator(
                      strokeWidth: 2.4, color: Colors.white))
              : Text(l10n.translate('auth.send_code')),
        ),
      ];

  List<Widget> _codeEntry(AppLocalizations l10n, AuthState auth) => [
        Text(l10n.translate('auth.code_label'),
            style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(auth.phone ?? '', style: Theme.of(context).textTheme.bodyMedium),
        const SizedBox(height: 16),
        TextField(
          controller: _code,
          keyboardType: TextInputType.number,
          autofocus: true,
          maxLength: 6,
          textAlign: TextAlign.center,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(
              fontSize: 30, letterSpacing: 12, fontWeight: FontWeight.w700),
          decoration: const InputDecoration(counterText: ''),
          onChanged: (v) {
            // Six digits is the whole code, so submit without making them
            // reach for a button — one less tap at a roadside.
            if (v.length == 6) {
              ref.read(authControllerProvider.notifier).verifyCode(v);
            }
          },
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: auth.busy
              ? null
              : () => ref
                  .read(authControllerProvider.notifier)
                  .verifyCode(_code.text.trim()),
          child: auth.busy
              ? const SizedBox(
                  width: 22, height: 22,
                  child: CircularProgressIndicator(
                      strokeWidth: 2.4, color: Colors.white))
              : Text(l10n.translate('auth.verify')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: () =>
              ref.read(authControllerProvider.notifier).backToPhone(),
          child: Text(l10n.translate('auth.change_number')),
        ),
      ];
}
