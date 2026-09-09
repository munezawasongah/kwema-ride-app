/// Driver dashboard: map, online toggle, earnings, and the active trip.
///
/// Design constraints that are not negotiable here: the driver is often on a
/// motorcycle, sometimes in rain, wearing a helmet, and glancing at the phone
/// for under a second. Everything actionable is at least 56px tall, high
/// contrast, and reachable with a thumb.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/format/tzs.dart';
import '../../core/l10n/language_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'driver_controller.dart';
import 'incoming_ride_modal.dart';
import '../shared/sos_button.dart';
import '../shared/rating_sheet.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  GoogleMapController? _map;
  bool _modalOpen = false;
  String? _ratedRideId;

  @override
  void dispose() {
    _map?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(driverControllerProvider);
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    // Offers arrive over the socket at any moment; showing the modal from a
    // listener keeps that out of the build method.
    ref.listen<DriverState>(driverControllerProvider, (previous, next) {
      final ride = next.activeRide;
      if (ride != null &&
          ride.status == RideStatus.completed &&
          _ratedRideId != ride.id) {
        _ratedRideId = ride.id;
        RatingSheet.show(
          context,
          rideId: ride.id,
          counterpartyName: l10n.translate('driver.rider_rating'),
          isRatingDriver: false,
        );
      }

      if (next.offer != null && !_modalOpen) {
        _modalOpen = true;
        IncomingRideModal.show(
          context,
          offer: next.offer!,
          onAccept: () => ref.read(driverControllerProvider.notifier).acceptOffer(),
          onDecline: (reason) =>
              ref.read(driverControllerProvider.notifier).declineOffer(reason),
          onExpire: () => ref.read(driverControllerProvider.notifier).offerExpired(),
        ).whenComplete(() => _modalOpen = false);
      }
    });

    return Scaffold(
      body: Stack(
        children: [
          GoogleMap(
            initialCameraPosition: CameraPosition(
              target: state.position ?? const LatLng(-6.8161, 39.2894),
              zoom: 15,
            ),
            onMapCreated: (c) => _map = c,
            myLocationEnabled: true,
            myLocationButtonEnabled: false,
            zoomControlsEnabled: false,
            compassEnabled: false,
            padding: const EdgeInsets.only(bottom: 260, top: 90),
          ),

          SafeArea(child: _StatusBar(state: state)),

          Align(
            alignment: Alignment.bottomCenter,
            child: state.activeRide != null
                ? _ActiveTripPanel(ride: state.activeRide!, busy: state.busy)
                : _IdlePanel(state: state),
          ),

          if (state.errorKey != null)
            Positioned(
              left: 16, right: 16, bottom: 280,
              child: Material(
                color: theme.colorScheme.error,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
                  child: Row(children: [
                    Expanded(
                      child: Text(
                        l10n.translate(state.errorKey!, params: {
                          'amount': formatTzs(state.debtCents),
                        }),
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, color: Colors.white),
                      onPressed: () => ref
                          .read(driverControllerProvider.notifier)
                          .clearError(),
                    ),
                  ]),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------

class _StatusBar extends ConsumerWidget {
  const _StatusBar({required this.state});
  final DriverState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: state.isOnline ? KwemaColors.go : theme.colorScheme.surface,
              borderRadius: BorderRadius.circular(999),
              boxShadow: const [
                BoxShadow(color: Color(0x1A000000), blurRadius: 10)
              ],
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 9, height: 9,
                decoration: BoxDecoration(
                  color: state.isOnline ? Colors.white : theme.colorScheme.outline,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                l10n.translate(
                    state.isOnline ? 'driver.online' : 'driver.offline'),
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: state.isOnline ? Colors.white : theme.colorScheme.onSurface,
                ),
              ),
            ]),
          ),
          const Spacer(),
          const LanguagePill(),
          const SizedBox(width: 8),
          Material(
            color: theme.colorScheme.surface,
            shape: const CircleBorder(),
            child: IconButton(
              icon: const Icon(Icons.logout, size: 20),
              onPressed: () =>
                  ref.read(authControllerProvider.notifier).signOut(),
            ),
          ),
        ],
      ),
    );
  }
}

class _IdlePanel extends ConsumerWidget {
  const _IdlePanel({required this.state});
  final DriverState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

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
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  _Stat(
                    value: '${state.tripsToday}',
                    label: l10n.translate('driver.trips'),
                  ),
                  _Stat(
                    value: formatTzs(state.earnedTodayCents),
                    label: l10n.translate('driver.earnings'),
                    highlight: true,
                  ),
                ],
              ),

              // Cash-commission debt. Shown whenever money is owed, not only
              // when blocked — a driver should see it building, not discover
              // it when offers stop.
              if (state.debtCents > 0) ...[
                const SizedBox(height: 14),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: state.isBlocked
                        ? theme.colorScheme.error.withValues(alpha: 0.10)
                        : KwemaColors.marigold50,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    l10n.translate('driver.debt_warning',
                        params: {'amount': formatTzs(state.debtCents)}),
                    style: TextStyle(
                      color: state.isBlocked
                          ? theme.colorScheme.error
                          : KwemaColors.marigold700,
                      fontSize: 13,
                    ),
                  ),
                ),
              ],

              const SizedBox(height: 16),
              // Available whenever the driver is online, not only on a trip.
              // Waiting alone at night is exactly when this is needed.
              if (state.isOnline) ...[
                const SosButton(compact: true),
                const SizedBox(height: 10),
              ],
              SizedBox(
                width: double.infinity,
                height: 60,
                child: state.isOnline
                    ? OutlinedButton(
                        onPressed: state.busy
                            ? null
                            : () => ref
                                .read(driverControllerProvider.notifier)
                                .goOffline(),
                        child: Text(l10n.translate('driver.go_offline'),
                            style: const TextStyle(fontSize: 17)),
                      )
                    : FilledButton(
                        onPressed: state.busy
                            ? null
                            : () => ref
                                .read(driverControllerProvider.notifier)
                                .goOnline(),
                        style: FilledButton.styleFrom(
                            backgroundColor: KwemaColors.go),
                        child: state.busy
                            ? const CircularProgressIndicator(
                                color: Colors.white, strokeWidth: 2.4)
                            : Text(l10n.translate('driver.go_online'),
                                style: const TextStyle(fontSize: 17)),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActiveTripPanel extends ConsumerWidget {
  const _ActiveTripPanel({required this.ride, required this.busy});
  final Ride ride;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(driverControllerProvider.notifier);

    late final String labelKey;
    late final VoidCallback? action;

    switch (ride.status) {
      case RideStatus.accepted:
        labelKey = 'driver.arrived_btn';
        action = controller.markArrived;
        break;
      case RideStatus.arrived:
        labelKey = 'driver.start_btn';
        action = controller.startTrip;
        break;
      case RideStatus.inProgress:
        labelKey = 'driver.complete_btn';
        action = controller.completeTrip;
        break;
      case RideStatus.completed:
        // Cash trips need explicit confirmation that the money changed hands.
        labelKey = ride.paymentMethod == 'cash'
            ? 'driver.cash_collected'
            : 'common.close';
        action = ride.paymentMethod == 'cash'
            ? controller.confirmCashCollected
            : controller.dismissTrip;
        break;
      default:
        labelKey = 'common.close';
        action = controller.dismissTrip;
    }

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
              Text(l10n.translate(ride.status.i18nKey),
                  style: theme.textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(formatTzs(ride.payableCents),
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(color: KwemaColors.marigold600)),
              const SizedBox(height: 6),
              Row(children: [
                Icon(
                  ride.paymentMethod == 'cash'
                      ? Icons.payments_outlined
                      : Icons.smartphone,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(l10n.translate('payment.${ride.paymentMethod}')),
              ]),
              const SizedBox(height: 12),
              SosButton(rideId: ride.id, compact: true),

              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 60,
                child: FilledButton(
                  onPressed: busy ? null : action,
                  child: Text(l10n.translate(labelKey),
                      style: const TextStyle(fontSize: 17)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label, this.highlight = false});
  final String value;
  final String label;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(children: [
      Text(value,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w800,
            color: highlight ? KwemaColors.marigold600 : null,
          )),
      Text(label, style: theme.textTheme.bodySmall),
    ]);
  }
}
