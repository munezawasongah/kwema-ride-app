/// Recipient and parcel details for a delivery.
///
/// Kept to what a courier genuinely needs to complete the job: who receives
/// it, how to reach them, what it is, and whether money changes hands. Every
/// extra field on this sheet is one more reason someone abandons the booking
/// while standing in a shop doorway.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format/tzs.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'rider_controller.dart';

class DeliveryFormSheet extends ConsumerStatefulWidget {
  const DeliveryFormSheet({super.key, required this.service});
  final ServiceType service;

  static Future<void> show(BuildContext context, ServiceType service) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => DeliveryFormSheet(service: service),
      );

  @override
  ConsumerState<DeliveryFormSheet> createState() => _DeliveryFormSheetState();
}

class _DeliveryFormSheetState extends ConsumerState<DeliveryFormSheet> {
  final _name = TextEditingController();
  final _phone = TextEditingController(text: '+255');
  final _what = TextEditingController();
  final _note = TextEditingController();
  final _cash = TextEditingController();

  String _size = 'small';
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = ref.read(riderControllerProvider).delivery;
    if (existing != null) {
      _name.text = existing.recipientName;
      _phone.text = existing.recipientPhone;
      _what.text = existing.description;
      _size = existing.size;
      _note.text = existing.recipientNote ?? '';
      if (existing.cashToCollectCents > 0) {
        _cash.text = (existing.cashToCollectCents / 100).round().toString();
      }
    }
    // Food is almost always a small item, and defaulting well saves a tap on
    // the most common case.
    if (widget.service == ServiceType.food) _size = 'small';
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _what, _note, _cash]) {
      c.dispose();
    }
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    final phone = _phone.text.replaceAll(' ', '');
    final what = _what.text.trim();

    if (name.length < 2) return setState(() => _error = 'delivery.err_name');
    if (!RegExp(r'^\+255[0-9]{9}$').hasMatch(phone)) {
      return setState(() => _error = 'error.phone_format');
    }
    if (what.length < 2) return setState(() => _error = 'delivery.err_what');

    final cash = parseTzsToCents(_cash.text) ?? 0;

    ref.read(riderControllerProvider.notifier).setDelivery(DeliveryDetails(
          recipientName: name,
          recipientPhone: phone,
          description: what,
          size: _size,
          recipientNote: _note.text.trim().isEmpty ? null : _note.text.trim(),
          cashToCollectCents: cash,
        ));
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Padding(
      padding: EdgeInsets.only(
        left: 22, right: 22, top: 4,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Icon(widget.service.icon, color: theme.colorScheme.primary),
              const SizedBox(width: 10),
              Text(l10n.translate(widget.service.labelKey),
                  style: theme.textTheme.titleLarge
                      ?.copyWith(fontWeight: FontWeight.w800)),
            ]),

            const SizedBox(height: 20),
            _label(l10n.translate('delivery.what')),
            TextField(
              controller: _what,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                hintText: l10n.translate('delivery.what_hint'),
                prefixIcon: const Icon(Icons.inventory_2_outlined),
              ),
            ),

            const SizedBox(height: 16),
            _label(l10n.translate('delivery.size')),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(
                    value: 'small', label: Text(l10n.translate('delivery.size_small'))),
                ButtonSegment(
                    value: 'medium', label: Text(l10n.translate('delivery.size_medium'))),
                ButtonSegment(
                    value: 'large', label: Text(l10n.translate('delivery.size_large'))),
              ],
              selected: {_size},
              onSelectionChanged: (v) => setState(() => _size = v.first),
            ),
            const SizedBox(height: 6),
            // Stated here rather than after a courier refuses at the door.
            Text(
              _size == 'large'
                  ? 'Gari tu'
                  : _size == 'medium'
                      ? 'Bajaji au gari'
                      : 'Bodaboda, bajaji au gari',
              style: theme.textTheme.bodySmall,
            ),

            const SizedBox(height: 20),
            Text(l10n.translate('delivery.recipient'),
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700)),

            const SizedBox(height: 10),
            _label(l10n.translate('delivery.recipient_name')),
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.person_outline)),
            ),

            const SizedBox(height: 14),
            _label(l10n.translate('delivery.recipient_phone')),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))],
              decoration: const InputDecoration(prefixIcon: Icon(Icons.phone_outlined)),
            ),

            const SizedBox(height: 14),
            _label(l10n.translate('delivery.note')),
            TextField(
              controller: _note,
              maxLines: 2,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.notes)),
            ),

            const SizedBox(height: 14),
            _label(l10n.translate('delivery.cash')),
            TextField(
              controller: _cash,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.payments_outlined),
                prefixText: 'TSh ',
              ),
            ),
            const SizedBox(height: 4),
            Text(l10n.translate('delivery.cash_hint'),
                style: theme.textTheme.bodySmall),

            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: KwemaColors.marigold50,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(children: [
                const Icon(Icons.info_outline,
                    size: 18, color: KwemaColors.marigold700),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(l10n.translate('delivery.no_insurance'),
                      style: const TextStyle(
                          fontSize: 13, color: KwemaColors.marigold700)),
                ),
              ]),
            ),

            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(l10n.translate(_error!),
                  style: TextStyle(color: theme.colorScheme.error)),
            ],

            const SizedBox(height: 18),
            SizedBox(
              height: 56,
              child: FilledButton(
                onPressed: _save,
                child: Text(l10n.translate('auth.name_continue')),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: Theme.of(context).textTheme.bodySmall),
      );
}
