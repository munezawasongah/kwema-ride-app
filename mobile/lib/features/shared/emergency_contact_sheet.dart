/// Emergency contact — the person we message if an SOS is raised.
///
/// Prompted for rather than buried, because it is the channel most likely to
/// actually produce help. Tanzania's 112 does not connect dependably outside
/// the larger cities, so a family member who can be reached by WhatsApp with
/// a map link is often the fastest route to someone arriving.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';

final emergencyContactProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get('/sos/contact');
  return (res as Map).cast<String, dynamic>();
});

class EmergencyContactSheet extends ConsumerStatefulWidget {
  const EmergencyContactSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => const EmergencyContactSheet(),
      );

  @override
  ConsumerState<EmergencyContactSheet> createState() =>
      _EmergencyContactSheetState();
}

class _EmergencyContactSheetState extends ConsumerState<EmergencyContactSheet> {
  final _name = TextEditingController();
  final _phone = TextEditingController(text: '+255');
  bool _busy = false;
  String? _error;
  bool _loaded = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final phone = _phone.text.replaceAll(' ', '');

    if (name.length < 2) {
      setState(() => _error = 'sos.err_name');
      return;
    }
    // International format, not only +255: plenty of people here have family
    // in Kenya, Uganda or the Gulf who would be the right person to call.
    if (!RegExp(r'^\+[0-9]{9,15}$').hasMatch(phone)) {
      setState(() => _error = 'sos.err_phone');
      return;
    }

    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(apiClientProvider).post('/sos/contact', {
        'name': name,
        'phone': phone,
      });
      ref.invalidate(emergencyContactProvider);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      setState(() { _busy = false; _error = e.message; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final existing = ref.watch(emergencyContactProvider);

    // Prefill once, so typing is not overwritten by a rebuild.
    existing.whenData((data) {
      if (!_loaded) {
        _loaded = true;
        if (data['name'] != null) _name.text = data['name'].toString();
        if (data['phone'] != null) _phone.text = data['phone'].toString();
      }
    });

    return Padding(
      padding: EdgeInsets.only(
        left: 24, right: 24, top: 6,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.translate('sos.contact_title'),
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          Text(l10n.translate('sos.contact_hint'),
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),

          const SizedBox(height: 20),
          Text(l10n.translate('sos.contact_name'),
              style: theme.textTheme.bodySmall),
          const SizedBox(height: 6),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline)),
          ),

          const SizedBox(height: 14),
          Text(l10n.translate('sos.contact_phone'),
              style: theme.textTheme.bodySmall),
          const SizedBox(height: 6),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))],
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.phone_outlined),
              hintText: '+255XXXXXXXXX',
            ),
          ),

          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(children: [
              const Icon(Icons.chat, size: 18, color: Color(0xFF25D366)),
              const SizedBox(width: 10),
              Expanded(
                child: Text(l10n.translate('sos.contact_channels'),
                    style: theme.textTheme.bodySmall),
              ),
            ]),
          ),

          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(l10n.translate(_error!),
                style: TextStyle(color: theme.colorScheme.error)),
          ],

          const SizedBox(height: 18),
          SizedBox(
            height: 56,
            child: FilledButton(
              onPressed: _busy ? null : _save,
              child: _busy
                  ? const SizedBox(
                      width: 22, height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.4, color: Colors.white))
                  : Text(l10n.translate('sos.contact_save')),
            ),
          ),
        ],
      ),
    );
  }
}
