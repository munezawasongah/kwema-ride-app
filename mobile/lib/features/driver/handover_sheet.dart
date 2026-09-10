/// Handover: the courier confirms the item reached the right person.
///
/// A four-digit code the recipient reads out, rather than a signature or a
/// photo. It works on any handset, needs no data at the doorstep, and proves
/// the right person actually received the item — a photo of a parcel on a
/// step proves only that it was put down somewhere.
///
/// The failure path is deliberately as easy to reach as the success path.
/// Nobody home is a routine outcome, and a courier who cannot record it will
/// either abandon the job or lie about it.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';

class HandoverSheet extends ConsumerStatefulWidget {
  const HandoverSheet({super.key, required this.rideId});
  final String rideId;

  /// Returns true when the handover was confirmed.
  static Future<bool> show(BuildContext context, String rideId) async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => HandoverSheet(rideId: rideId),
    );
    return result ?? false;
  }

  @override
  ConsumerState<HandoverSheet> createState() => _HandoverSheetState();
}

class _HandoverSheetState extends ConsumerState<HandoverSheet> {
  final _code = TextEditingController();
  final _receivedBy = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    _receivedBy.dispose();
    super.dispose();
  }

  Future<void> _confirm() async {
    final code = _code.text.trim();
    if (!RegExp(r'^[0-9]{4}$').hasMatch(code)) {
      setState(() => _error = 'delivery.wrong_code');
      return;
    }
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(apiClientProvider).post(
        '/deliveries/${widget.rideId}/confirm',
        {'code': code, 'receivedBy': _receivedBy.text.trim()},
      );
      HapticFeedback.mediumImpact();
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (_) {
      setState(() { _busy = false; _error = 'delivery.wrong_code'; });
    }
  }

  Future<void> _reportFailure() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final controller = TextEditingController();
        return AlertDialog(
          title: Text(AppLocalizations.of(ctx).translate('delivery.failed_title')),
          content: TextField(controller: controller, maxLines: 2),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(AppLocalizations.of(ctx).translate('common.close')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text.trim()),
              child: Text(AppLocalizations.of(ctx).translate('rating.submit')),
            ),
          ],
        );
      },
    );
    if (reason == null || reason.length < 3) return;

    try {
      await ref.read(apiClientProvider)
          .post('/deliveries/${widget.rideId}/failed', {'reason': reason});
      if (mounted) Navigator.of(context).pop(false);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Padding(
      padding: EdgeInsets.only(
        left: 24, right: 24, top: 6,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.translate('delivery.enter_code'),
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 18),

          TextField(
            controller: _code,
            keyboardType: TextInputType.number,
            autofocus: true,
            maxLength: 4,
            textAlign: TextAlign.center,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(
                fontSize: 32, letterSpacing: 14, fontWeight: FontWeight.w700),
            decoration: const InputDecoration(counterText: ''),
            onChanged: (v) { if (v.length == 4) _confirm(); },
          ),

          const SizedBox(height: 10),
          TextField(
            controller: _receivedBy,
            textCapitalization: TextCapitalization.words,
            decoration: InputDecoration(
              labelText: l10n.translate('delivery.received_by'),
              prefixIcon: const Icon(Icons.person_outline),
            ),
          ),

          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(l10n.translate(_error!),
                textAlign: TextAlign.center,
                style: TextStyle(color: theme.colorScheme.error)),
          ],

          const SizedBox(height: 20),
          SizedBox(
            height: 58,
            child: FilledButton(
              onPressed: _busy ? null : _confirm,
              style: FilledButton.styleFrom(backgroundColor: KwemaColors.go),
              child: _busy
                  ? const SizedBox(
                      width: 22, height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.4, color: Colors.white))
                  : Text(l10n.translate('delivery.confirm'),
                      style: const TextStyle(fontSize: 17)),
            ),
          ),

          const SizedBox(height: 8),
          TextButton(
            onPressed: _busy ? null : _reportFailure,
            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
            child: Text(l10n.translate('delivery.failed_title')),
          ),
        ],
      ),
    );
  }
}
