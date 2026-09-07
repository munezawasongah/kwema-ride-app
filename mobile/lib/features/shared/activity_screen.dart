/// Trip history, shared by both apps.
///
/// The API returns the same rows for a rider and a driver — the server scopes
/// by whichever side of the trip the caller was on — so one screen serves
/// both. Only the labelling differs: a rider sees what they paid, a driver
/// sees what they earned.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format/tzs.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';

class RideHistoryEntry {
  const RideHistoryEntry({
    required this.id,
    required this.reference,
    required this.status,
    required this.category,
    required this.requestedAt,
    required this.pickupAddress,
    required this.dropoffAddress,
    required this.fareCents,
    required this.paymentMethod,
  });

  final String id;
  final String reference;
  final RideStatus status;
  final VehicleCategory category;
  final DateTime requestedAt;
  final String pickupAddress;
  final String dropoffAddress;
  final int fareCents;
  final String paymentMethod;

  factory RideHistoryEntry.fromJson(Map<String, dynamic> j) => RideHistoryEntry(
        id: j['id']?.toString() ?? '',
        reference: j['reference']?.toString() ?? '',
        status: RideStatus.fromWire(j['status']?.toString()),
        category: VehicleCategory.fromWire(j['requested_category']?.toString()),
        requestedAt:
            DateTime.tryParse(j['requested_at']?.toString() ?? '') ?? DateTime.now(),
        pickupAddress: j['pickup_address']?.toString() ?? '',
        dropoffAddress: j['dropoff_address']?.toString() ?? '',
        fareCents: int.tryParse(j['final_fare_cents']?.toString() ?? '') ?? 0,
        paymentMethod: j['payment_method']?.toString() ?? 'cash',
      );
}

final rideHistoryProvider =
    FutureProvider.autoDispose<List<RideHistoryEntry>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get('/rides/history', query: {'limit': 40});
  return (res as List)
      .map((e) => RideHistoryEntry.fromJson((e as Map).cast<String, dynamic>()))
      .toList();
});

class ActivityScreen extends ConsumerWidget {
  const ActivityScreen({super.key, this.isDriver = false});
  final bool isDriver;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final history = ref.watch(rideHistoryProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.translate('nav.activity'))),
      body: history.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) => _Message(
          icon: Icons.cloud_off,
          title: l10n.translate('error.network'),
          action: TextButton(
            onPressed: () => ref.invalidate(rideHistoryProvider),
            child: Text(l10n.translate('common.retry')),
          ),
        ),
        data: (rides) {
          if (rides.isEmpty) {
            return _Message(
              icon: Icons.receipt_long_outlined,
              title: l10n.translate('activity.empty'),
            );
          }
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(rideHistoryProvider),
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: rides.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, i) =>
                  _RideTile(entry: rides[i], isDriver: isDriver),
            ),
          );
        },
      ),
    );
  }
}

class _RideTile extends StatelessWidget {
  const _RideTile({required this.entry, required this.isDriver});
  final RideHistoryEntry entry;
  final bool isDriver;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final cancelled = entry.status == RideStatus.cancelled ||
        entry.status == RideStatus.expired;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border.all(color: theme.colorScheme.outline),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Container(
              width: 6, height: 30,
              decoration: BoxDecoration(
                color: entry.category.colour,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l10n.categoryName(entry.category),
                      style: theme.textTheme.titleMedium
                          ?.copyWith(fontWeight: FontWeight.w700)),
                  Text(_formatDate(entry.requestedAt),
                      style: theme.textTheme.bodySmall),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  cancelled ? '—' : formatTzs(entry.fareCents),
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: cancelled
                        ? theme.colorScheme.onSurfaceVariant
                        : (isDriver ? KwemaColors.marigold600 : null),
                  ),
                ),
                Text(l10n.translate('payment.${entry.paymentMethod}'),
                    style: theme.textTheme.bodySmall),
              ],
            ),
          ]),

          if (entry.pickupAddress.isNotEmpty ||
              entry.dropoffAddress.isNotEmpty) ...[
            const SizedBox(height: 10),
            _Leg(colour: KwemaColors.go, text: entry.pickupAddress),
            const SizedBox(height: 4),
            _Leg(colour: KwemaColors.stop, text: entry.dropoffAddress),
          ],

          if (cancelled) ...[
            const SizedBox(height: 8),
            Text(l10n.translate(entry.status.i18nKey),
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.error)),
          ],
        ],
      ),
    );
  }

  String _formatDate(DateTime d) {
    final local = d.toLocal();
    final two = (int n) => n.toString().padLeft(2, '0');
    return '${two(local.day)}/${two(local.month)}/${local.year}  '
        '${two(local.hour)}:${two(local.minute)}';
  }
}

class _Leg extends StatelessWidget {
  const _Leg({required this.colour, required this.text});
  final Color colour;
  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    return Row(children: [
      Container(
        width: 8, height: 8,
        decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
      ),
      const SizedBox(width: 8),
      Expanded(
        child: Text(text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall),
      ),
    ]);
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.title, this.action});
  final IconData icon;
  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 52, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 14),
            Text(title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium),
            if (action != null) ...[const SizedBox(height: 12), action!],
          ],
        ),
      ),
    );
  }
}
