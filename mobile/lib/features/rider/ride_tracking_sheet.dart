/// Live trip panel: status, driver details, and payment on completion.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/format/tzs.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'rider_controller.dart';
import '../shared/sos_button.dart';

class RideTrackingSheet extends ConsumerWidget {
  const RideTrackingSheet({super.key, required this.ride});
  final Ride ride;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(riderControllerProvider.notifier);
    final searching = ride.status == RideStatus.searching ||
        ride.status == RideStatus.requested;

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: const [
          BoxShadow(color: Color(0x1A000000), blurRadius: 24, offset: Offset(0, -4))
        ],
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                if (searching)
                  const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.4),
                  ),
                if (searching) const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    l10n.translate(ride.status.i18nKey),
                    style: theme.textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (ride.etaSeconds != null && ride.etaSeconds! > 0)
                  Text(
                    l10n.translate('rider.eta_min',
                        params: {'min': '${(ride.etaSeconds! / 60).ceil()}'}),
                    style: theme.textTheme.titleMedium
                        ?.copyWith(color: theme.colorScheme.primary),
                  ),
              ]),

              if (ride.reference.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(ride.reference, style: theme.textTheme.bodySmall),
              ],

              if (ride.driver != null) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Row(children: [
                    CircleAvatar(
                      radius: 22,
                      backgroundColor: theme.colorScheme.primary,
                      child: Text(
                        ride.driver!.name.isEmpty
                            ? '?'
                            : ride.driver!.name.substring(0, 1).toUpperCase(),
                        style: const TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w700),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(ride.driver!.name,
                              style: theme.textTheme.titleMedium
                                  ?.copyWith(fontWeight: FontWeight.w700)),
                          Text(
                            '★ ${ride.driver!.rating.toStringAsFixed(1)}'
                            '${ride.vehicle == null ? '' : ' · ${ride.vehicle!.plate}'}',
                            style: theme.textTheme.bodySmall,
                          ),
                          if (ride.vehicle != null)
                            Text(
                              '${ride.vehicle!.colour} ${ride.vehicle!.make} '
                              '${ride.vehicle!.model}',
                              style: theme.textTheme.bodySmall,
                            ),
                        ],
                      ),
                    ),
                    // Calls go through the masked number the server supplies,
                    // never the driver's real line.
                    if (ride.driver!.phoneMasked.isNotEmpty)
                      IconButton.filled(
                        icon: const Icon(Icons.phone, size: 20),
                        onPressed: () => launchUrl(
                            Uri.parse('tel:${ride.driver!.phoneMasked}')),
                      ),
                  ]),
                ),
              ],

              const SizedBox(height: 16),
              Row(children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.translate('rider.estimated_fare'),
                          style: theme.textTheme.bodySmall),
                      Text(formatTzs(ride.payableCents),
                          style: theme.textTheme.headlineSmall
                              ?.copyWith(fontWeight: FontWeight.w800)),
                    ],
                  ),
                ),
                Chip(label: Text(l10n.translate('payment.${ride.paymentMethod}'))),
              ]),

              // Available for the whole trip, not only when something has
              // already gone wrong.
              if (!ride.status.isTerminal) ...[
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(child: SosButton(rideId: ride.id, compact: true)),
                ]),
              ],

              const SizedBox(height: 14),

              if (ride.status == RideStatus.completed && !ride.isPaid &&
                  ride.paymentMethod != 'cash')
                SizedBox(
                  width: double.infinity, height: 56,
                  child: FilledButton(
                    onPressed: () async {
                      final url = await controller.payNow();
                      // Card payments open the provider's hosted 3-D Secure
                      // page. Card fields are never rendered by this app,
                      // which is what keeps it out of PCI scope.
                      if (url != null) {
                        await launchUrl(Uri.parse(url),
                            mode: LaunchMode.externalApplication);
                      }
                    },
                    child: Text(l10n.translate('rider.pay_now')),
                  ),
                )
              else if (ride.status.isTerminal || ride.isPaid)
                SizedBox(
                  width: double.infinity, height: 56,
                  child: FilledButton(
                    onPressed: controller.dismissRide,
                    child: Text(l10n.translate('common.close')),
                  ),
                )
              else
                SizedBox(
                  width: double.infinity, height: 52,
                  child: OutlinedButton(
                    onPressed: () => _confirmCancel(context, ref, l10n),
                    style: OutlinedButton.styleFrom(
                        foregroundColor: theme.colorScheme.error),
                    child: Text(l10n.translate('rider.cancel')),
                  ),
                ),

              if (ride.isPaid) ...[
                const SizedBox(height: 8),
                Row(children: [
                  const Icon(Icons.check_circle, color: KwemaColors.go, size: 18),
                  const SizedBox(width: 6),
                  Text(l10n.translate('payment.success'),
                      style: const TextStyle(color: KwemaColors.go)),
                ]),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// Cancelling after a driver has committed time may carry a fee, so it
  /// asks first rather than firing on a mis-tap.
  Future<void> _confirmCancel(
      BuildContext context, WidgetRef ref, AppLocalizations l10n) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l10n.translate('rider.cancel')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l10n.translate('common.close')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l10n.translate('rider.cancel')),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(riderControllerProvider.notifier).cancelRide();
    }
  }
}
