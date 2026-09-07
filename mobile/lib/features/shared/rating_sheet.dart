/// Post-trip rating, one to five stars.
///
/// Shown once when a trip completes. Deliberately skippable: a rating forced
/// out of someone in a hurry is noise, and a driver's livelihood should not
/// hang on a tap made to dismiss a dialog.
///
/// The server decides who is rating whom from the ride itself, so this widget
/// only sends the number.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';

class RatingSheet extends ConsumerStatefulWidget {
  const RatingSheet({
    super.key,
    required this.rideId,
    required this.counterpartyName,
    this.isRatingDriver = true,
  });

  final String rideId;
  final String counterpartyName;
  final bool isRatingDriver;

  static Future<void> show(
    BuildContext context, {
    required String rideId,
    required String counterpartyName,
    bool isRatingDriver = true,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => RatingSheet(
        rideId: rideId,
        counterpartyName: counterpartyName,
        isRatingDriver: isRatingDriver,
      ),
    );
  }

  @override
  ConsumerState<RatingSheet> createState() => _RatingSheetState();
}

class _RatingSheetState extends ConsumerState<RatingSheet> {
  int _stars = 0;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (_stars == 0) return;
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(apiClientProvider).post(
        '/rides/${widget.rideId}/rate',
        {'stars': _stars},
      );
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      setState(() { _busy = false; _error = e.message; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    // Wording changes with the number, the way Uber does it — a bare star
    // count tells the rater nothing about what they are saying.
    const labelKeys = [
      '', 'rating.1', 'rating.2', 'rating.3', 'rating.4', 'rating.5',
    ];

    return Padding(
      padding: EdgeInsets.only(
        left: 24, right: 24, top: 8,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            l10n.translate(
              widget.isRatingDriver ? 'rating.title_driver' : 'rating.title_rider',
              params: {'name': widget.counterpartyName},
            ),
            textAlign: TextAlign.center,
            style: theme.textTheme.titleLarge
                ?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 20),

          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(5, (i) {
              final value = i + 1;
              final filled = value <= _stars;
              return Semantics(
                button: true,
                label: '$value',
                child: IconButton(
                  iconSize: 44,
                  // Large hit area: this is tapped one-handed, often while
                  // getting out of a vehicle.
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  constraints: const BoxConstraints(minWidth: 56, minHeight: 56),
                  icon: Icon(
                    filled ? Icons.star_rounded : Icons.star_outline_rounded,
                    color: filled
                        ? KwemaColors.marigold500
                        : theme.colorScheme.outline,
                  ),
                  onPressed: _busy ? null : () => setState(() => _stars = value),
                ),
              );
            }),
          ),

          SizedBox(
            height: 24,
            child: _stars == 0
                ? const SizedBox.shrink()
                : Text(l10n.translate(labelKeys[_stars]),
                    style: theme.textTheme.titleMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant)),
          ),

          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
          ],

          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: FilledButton(
              onPressed: (_stars == 0 || _busy) ? null : _submit,
              child: _busy
                  ? const SizedBox(
                      width: 22, height: 22,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.4, color: Colors.white))
                  : Text(l10n.translate('rating.submit')),
            ),
          ),
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            child: Text(l10n.translate('rating.skip')),
          ),
        ],
      ),
    );
  }
}
