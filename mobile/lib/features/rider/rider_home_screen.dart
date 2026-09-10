/// Rider home.
///
/// The map is the screen; everything else rises over it. Riders here are
/// often standing at a roadside in bright sun on a mid-range Android device,
/// so this commits to large tap targets, high contrast, and never blocking
/// the UI on a network call. A stale price renders at reduced opacity while
/// re-quoting rather than being replaced by a spinner — a number that dims
/// reads as "updating", a blank box reads as broken.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/format/tzs.dart';
import '../../core/l10n/language_controller.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';
import '../../core/theme/app_theme.dart';
import 'rider_controller.dart';
import 'ride_tracking_sheet.dart';
import 'delivery_form_sheet.dart';
import '../shared/sos_button.dart';
import '../shared/rating_sheet.dart';

class RiderHomeScreen extends ConsumerStatefulWidget {
  const RiderHomeScreen({super.key});

  @override
  ConsumerState<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

class _RiderHomeScreenState extends ConsumerState<RiderHomeScreen> {
  GoogleMapController? _map;
  final _searchController = TextEditingController();

  @override
  void dispose() {
    _map?.dispose();
    _searchController.dispose();
    super.dispose();
  }

  Set<Marker> _markers(RiderState s) {
    final markers = <Marker>{};
    if (s.pickup != null) {
      markers.add(Marker(
        markerId: const MarkerId('pickup'),
        position: s.pickup!,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
      ));
    }
    if (s.dropoff != null) {
      markers.add(Marker(
        markerId: const MarkerId('dropoff'),
        position: s.dropoff!,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
      ));
    }
    if (s.driverPosition != null) {
      markers.add(Marker(
        markerId: const MarkerId('driver'),
        position: s.driverPosition!,
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
      ));
    }
    return markers;
  }

  /// Guards against the sheet reopening on every rebuild while the completed
  /// ride is still on screen.
  String? _ratedRideId;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(riderControllerProvider);
    final l10n = AppLocalizations.of(context);

    // Rating is offered once, when the trip closes.
    ref.listen<RiderState>(riderControllerProvider, (previous, next) {
      final ride = next.ride;
      if (ride == null) return;
      if (ride.status != RideStatus.completed) return;
      if (ride.driver == null) return;
      if (_ratedRideId == ride.id) return;
      _ratedRideId = ride.id;
      RatingSheet.show(
        context,
        rideId: ride.id,
        counterpartyName: ride.driver!.name,
      );
    });

    return Scaffold(
      body: Stack(
        children: [
          GoogleMap(
            initialCameraPosition: CameraPosition(
              // Posta, Dar es Salaam — a sensible cold-start centre.
              target: state.pickup ?? const LatLng(-6.8161, 39.2894),
              zoom: 15,
            ),
            onMapCreated: (c) => _map = c,
            markers: _markers(state),
            myLocationEnabled: true,
            myLocationButtonEnabled: false,
            zoomControlsEnabled: false,
            compassEnabled: false,
            padding: EdgeInsets.only(
                bottom: state.hasActiveRide ? 280 : 330, top: 100),
          ),

          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                // Reachable at any time, not only once a trip is underway.
                // Someone walking to a pickup point is still a rider.
                const SosButton(compact: true),
                const Expanded(child: SizedBox()),
                const LanguagePill(),
                const SizedBox(width: 8),
                Material(
                  color: Theme.of(context).colorScheme.surface,
                  shape: const CircleBorder(),
                  child: IconButton(
                    icon: const Icon(Icons.logout, size: 20),
                    onPressed: () =>
                        ref.read(authControllerProvider.notifier).signOut(),
                  ),
                ),
              ]),
            ),
          ),

          Align(
            alignment: Alignment.bottomCenter,
            child: state.hasActiveRide
                ? RideTrackingSheet(ride: state.ride!)
                : _BookingSheet(
                    state: state,
                    searchController: _searchController,
                  ),
          ),

          if (state.errorKey != null && !state.hasActiveRide)
            Positioned(
              left: 16, right: 16, bottom: 350,
              child: Material(
                color: Theme.of(context).colorScheme.error,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
                  child: Row(children: [
                    Expanded(
                      child: Text(l10n.translate(state.errorKey!),
                          style: const TextStyle(color: Colors.white)),
                    ),
                    IconButton(
                      icon: const Icon(Icons.close, color: Colors.white),
                      onPressed: () =>
                          ref.read(riderControllerProvider.notifier).clearError(),
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

class _BookingSheet extends ConsumerWidget {
  const _BookingSheet({required this.state, required this.searchController});

  final RiderState state;
  final TextEditingController searchController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final controller = ref.read(riderControllerProvider.notifier);

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
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Product switch. Three tabs rather than a menu: the choice is
              // made before anything else and must be visible, not hidden.
              _ServiceTabs(
                selected: state.service,
                onSelect: (s) => controller.setService(s),
              ),
              const SizedBox(height: 12),

              TextField(
                controller: searchController,
                decoration: InputDecoration(
                  hintText: l10n.translate('rider.where_to'),
                  prefixIcon: const Icon(Icons.search),
                ),
                onChanged: controller.searchPlaces,
              ),

              if (state.suggestions.isNotEmpty)
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 220),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: state.suggestions.length,
                    itemBuilder: (context, i) {
                      final s = state.suggestions[i];
                      return ListTile(
                        dense: true,
                        leading: const Icon(Icons.place_outlined, size: 20),
                        title: Text(s.primary,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(s.secondary,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        onTap: () {
                          searchController.text = s.primary;
                          FocusScope.of(context).unfocus();
                          controller.chooseDestination(s);
                        },
                      );
                    },
                  ),
                ),

              if (state.service.isDelivery) ...[
                const SizedBox(height: 10),
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => DeliveryFormSheet.show(context, state.service),
                  child: Container(
                    padding: const EdgeInsets.all(13),
                    decoration: BoxDecoration(
                      color: state.delivery == null
                          ? theme.colorScheme.errorContainer.withValues(alpha: 0.35)
                          : theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(children: [
                      Icon(state.delivery == null
                          ? Icons.assignment_late_outlined
                          : Icons.assignment_turned_in_outlined),
                      const SizedBox(width: 11),
                      Expanded(
                        child: state.delivery == null
                            ? Text(l10n.translate('delivery.recipient'),
                                style: const TextStyle(fontWeight: FontWeight.w600))
                            : Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(state.delivery!.recipientName,
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w700)),
                                  Text(state.delivery!.description,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: theme.textTheme.bodySmall),
                                ],
                              ),
                      ),
                      const Icon(Icons.chevron_right),
                    ]),
                  ),
                ),
              ],

              if (state.quotes.isNotEmpty) ...[
                const SizedBox(height: 12),
                SizedBox(
                  height: 128,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: state.quotes.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 10),
                    itemBuilder: (context, i) {
                      final quote = state.quotes[i];
                      return _CategoryCard(
                        quote: quote,
                        isSelected: state.selected?.category == quote.category,
                        isQuoting: state.isQuoting,
                        onTap: () => controller.selectCategory(quote.category),
                      );
                    },
                  ),
                ),

                const SizedBox(height: 12),
                _PaymentSelector(
                  selected: state.paymentMethod,
                  onSelect: controller.setPaymentMethod,
                ),

                const SizedBox(height: 12),
                Row(children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l10n.translate('rider.estimated_fare'),
                            style: theme.textTheme.bodySmall),
                        AnimatedOpacity(
                          opacity: state.isQuoting ? 0.45 : 1,
                          duration: const Duration(milliseconds: 180),
                          child: Text(
                            state.selected == null
                                ? '—'
                                : formatTzs(state.selected!.totalFareCents),
                            style: theme.textTheme.headlineSmall
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (state.selected != null &&
                      state.selected!.fare.surgeMultiplier > 1)
                    _SurgeChip(
                        multiplier: state.selected!.fare.surgeMultiplier),
                ]),

                // Reusing the network-error string here was wrong: nothing is
                // offline, the server just could not route this leg and fell
                // back to a straight-line estimate. Say that instead.
                if (state.selected?.isEstimate == true) ...[
                  const SizedBox(height: 6),
                  Text(l10n.translate('rider.fare_approx'),
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: KwemaColors.marigold700)),
                ],

                const SizedBox(height: 10),
                SizedBox(
                  height: 56,
                  child: FilledButton(
                    onPressed: state.canRequest && !state.isRequesting
                        ? controller.requestRide
                        : null,
                    child: state.isRequesting
                        ? const SizedBox(
                            width: 22, height: 22,
                            child: CircularProgressIndicator(
                                strokeWidth: 2.4, color: Colors.white))
                        : Text(
                            l10n.translate('rider.request_ride', params: {
                              'category': state.selected == null
                                  ? ''
                                  : l10n.categoryName(state.selected!.category),
                            }),
                            style: const TextStyle(fontSize: 16),
                          ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.quote,
    required this.isSelected,
    required this.isQuoting,
    required this.onTap,
  });

  final FareQuote quote;
  final bool isSelected;
  final bool isQuoting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return Semantics(
      selected: isSelected,
      button: true,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 116,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
          decoration: BoxDecoration(
            color: isSelected
                ? quote.category.colour.withValues(alpha: 0.10)
                : theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: isSelected ? quote.category.colour : Colors.transparent,
              width: 2,
            ),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // Tier colour bar rather than an icon: riders with limited
              // literacy recognise the tile by colour before reading it.
              Container(
                width: 28, height: 5,
                decoration: BoxDecoration(
                  color: quote.category.colour,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(height: 10),
              Text(l10n.categoryName(quote.category),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight:
                          isSelected ? FontWeight.w800 : FontWeight.w500)),
              const SizedBox(height: 4),
              AnimatedOpacity(
                opacity: isQuoting ? 0.45 : 1,
                duration: const Duration(milliseconds: 180),
                child: Text(formatTzsCompact(quote.totalFareCents),
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700)),
              ),
              Text(
                l10n.translate('rider.eta_min',
                    params: {'min': '${(quote.etaSeconds / 60).ceil()}'}),
                style: theme.textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PaymentSelector extends StatelessWidget {
  const _PaymentSelector({required this.selected, required this.onSelect});
  final String selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    const methods = ['mobile_money', 'card', 'cash'];

    return Row(
      children: methods.map((m) {
        final on = m == selected;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: GestureDetector(
              onTap: () => onSelect(m),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 11),
                decoration: BoxDecoration(
                  color: on
                      ? theme.colorScheme.primaryContainer
                      : theme.colorScheme.surface,
                  border: Border.all(
                    color: on ? theme.colorScheme.primary : theme.colorScheme.outline,
                    width: on ? 2 : 1,
                  ),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Center(
                  child: Text(
                    l10n.translate('payment.$m'),
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}

class _SurgeChip extends StatelessWidget {
  const _SurgeChip({required this.multiplier});
  final double multiplier;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: KwemaColors.marigold50,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.trending_up, size: 16, color: KwemaColors.marigold700),
        const SizedBox(width: 6),
        // Stating the reason rather than a bare multiplier cuts complaints.
        Text(
          l10n.translate('rider.surge_active',
              params: {'x': multiplier.toStringAsFixed(1)}),
          style: const TextStyle(
              color: KwemaColors.marigold700,
              fontWeight: FontWeight.w600,
              fontSize: 13),
        ),
      ]),
    );
  }
}


/// Ride, parcel or food. Colour and icon carry the distinction as much as the
/// word does, for the same reason the vehicle tiers use coloured bars.
class _ServiceTabs extends StatelessWidget {
  const _ServiceTabs({required this.selected, required this.onSelect});

  final ServiceType selected;
  final ValueChanged<ServiceType> onSelect;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Row(
      children: ServiceType.values.map((service) {
        final on = service == selected;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: GestureDetector(
              onTap: () => onSelect(service),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsets.symmetric(vertical: 11),
                decoration: BoxDecoration(
                  color: on
                      ? theme.colorScheme.primaryContainer
                      : theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: on ? theme.colorScheme.primary : Colors.transparent,
                    width: 2,
                  ),
                ),
                child: Column(children: [
                  Icon(service.icon,
                      size: 21,
                      color: on
                          ? theme.colorScheme.primary
                          : theme.colorScheme.onSurfaceVariant),
                  const SizedBox(height: 3),
                  Text(
                    l10n.translate(service.labelKey),
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: on ? FontWeight.w800 : FontWeight.w500,
                      color: on ? theme.colorScheme.primary : null,
                    ),
                  ),
                ]),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}
