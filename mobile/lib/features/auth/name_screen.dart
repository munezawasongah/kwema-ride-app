/// Name capture, shown once after a new number is verified.
///
/// Asked here rather than left as a placeholder because this name is what a
/// driver reads on an incoming request and what a rider reads on the trip
/// screen. "Mteja" on both sides tells neither person anything.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/l10n/localization.dart';

class NameScreen extends ConsumerStatefulWidget {
  const NameScreen({super.key});

  @override
  ConsumerState<NameScreen> createState() => _NameScreenState();
}

class _NameScreenState extends ConsumerState<NameScreen> {
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    final existing = ref.read(authControllerProvider).user?.fullName ?? '';
    _controller.text = existing;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 40),
              Text(l10n.translate('auth.name_title'),
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              Text(l10n.translate('auth.name_hint'),
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
              const SizedBox(height: 28),
              TextField(
                controller: _controller,
                autofocus: true,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.done,
                maxLength: 120,
                inputFormatters: [LengthLimitingTextInputFormatter(120)],
                style: const TextStyle(fontSize: 19),
                decoration: InputDecoration(
                  hintText: l10n.translate('auth.name_placeholder'),
                  counterText: '',
                  prefixIcon: const Icon(Icons.person_outline),
                ),
                onSubmitted: (v) =>
                    ref.read(authControllerProvider.notifier).saveName(v),
              ),
              if (auth.error != null) ...[
                const SizedBox(height: 12),
                Text(l10n.translate(auth.error!),
                    style: TextStyle(color: theme.colorScheme.error)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: auth.busy
                    ? null
                    : () => ref
                        .read(authControllerProvider.notifier)
                        .saveName(_controller.text),
                child: auth.busy
                    ? const SizedBox(
                        width: 22, height: 22,
                        child: CircularProgressIndicator(
                            strokeWidth: 2.4, color: Colors.white))
                    : Text(l10n.translate('auth.name_continue')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
