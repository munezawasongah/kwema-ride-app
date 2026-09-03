/// Rider home screen.
///
/// Layout intent: the map is the screen, and everything else is a sheet that
/// rises over it. Riders here are often standing at a roadside in bright sun
/// on a mid-range Android device, so the design commits to three things —
/// large tap targets, high contrast, and never blocking the UI on a network
/// call. Prices render the instant a local estimate is available and reconcile
/// when the server quote lands.
///
/// Swahili is the default language; English is the fallback. All strings come
/// from the l10n delegate, none are inline.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/format/tzs.dart';
import '../../core/l10n/app_localizations.dart';
import '../../core/models/vehicle_category.dart';
import '../../core/models/fare_quote.dart';
import 'rider_controller.dart';

class RiderHomeScreen extends ConsumerStatefulWidget {
  const RiderHomeScreen({super.key});

  @override
  ConsumerState<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

class _RiderHomeScreenState extends ConsumerState<RiderHomeScreen> {
  GoogleMapController? _map;
  Timer? _quoteDebounce;

  @override
  void dispose() {
    _quoteDebounce?.cancel();
    _map?.dispose();
    super.dispose();
  }

  /// Requesting a new quote on every marker drag would burn both the maps
  /// quota and the rider's bundle. 600 ms after they stop moving is enough.
  void _scheduleQuote() {
    _quoteDebounce?.cancel();
    _quoteDebounce = Timer(const Duration(milliseconds: 600), () {
      ref.read(riderControllerProvider.notifier).refreshQuote();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(riderControllerProvider);
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      body: Stack(
        children: [
          GoogleMap(
            initialCameraPosition: const CameraPosition(
              // Posta, Dar es Salaam — a sensible cold-start centre.
              target: LatLng(-6.8161, 39.2894),
              zoom: 15,
            ),
            onMapCreated: (c) {
              _map = c;
              ref.read(riderControllerProvider.notifier).attachMap(c);
            },
            onCameraMove: (pos) {
              ref.read(riderControllerProvider.notifier).setPickup(pos.target);
            },
            onCameraIdle: _scheduleQuote,
            markers: state.driverMarkers,
            polylines: state.routePolylines,
            myLocationEnabled: true,
            myLocationButtonEnabled: false,
            // Cuts frame cost noticeably on entry-level devices.
            liteModeEnabled: false,
            compassEnabled: false,
            zoomControlsEnabled: false,
            padding: const EdgeInsets.only(bottom: 320),
          ),

          // Centre pin. Stays fixed while the map moves under it, which reads
          // as more responsive than dragging a marker on a slow device.
          const IgnorePointer(
            child: Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: 320 + 24),
                child: _PickupPin(),
              ),
            ),
          ),

          SafeArea(child: _DestinationBar(destination: state.destinationLabel)),

          Align(
            alignment: Alignment.bottomCenter,
            child: _RequestSheet(
              categories: state.availableCategories,
              selected: state.selectedCategory,
              quotes: state.quotes,
              isQuoting: state.isQuoting,
              canRequest: state.canRequest,
              isRequesting: state.isRequesting,
              onSelect: (c) {
                ref.read(riderControllerProvider.notifier).selectCategory(c);
              },
              onRequest: () {
                ref.read(riderControllerProvider.notifier).requestRide();
              },
            ),
          ),

          if (state.errorKey != null)
            Positioned(
              left: 16,
              right: 16,
              bottom: 340,
              child: _ErrorBanner(
                message: l10n.translate(state.errorKey!),
                onDismiss: () =>
                    ref.read(riderControllerProvider.notifier).clearError(),
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------
// Bottom sheet: category carousel + fare + request button
// ---------------------------------------------------------------------

class _RequestSheet extends StatelessWidget {
  const _RequestSheet({
    required this.categories,
    required this.selected,
    required this.quotes,
    required this.isQuoting,
    required this.canRequest,
    required this.isRequesting,
    required this.onSelect,
    required this.onRequest,
  });

  final List<VehicleCategory> categories;
  final VehicleCategory selected;
  final Map<VehicleCategory, FareQuote> quotes;
  final bool isQuoting;
  final bool canRequest;
  final bool isRequesting;
  final ValueChanged<VehicleCategory> onSelect;
  final VoidCallback onRequest;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final quote = quotes[selected];

    return Container(
      padding: const EdgeInsets.fromLTRB(0, 12, 0, 0),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: const [
          BoxShadow(color: Color(0x1A000000), blurRadius: 24, offset: Offset(0, -4)),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: theme.dividerColor,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 16),

            // --- Category carousel ---------------------------------
            SizedBox(
              height: 132,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: categories.length,
                separatorBuilder: (_, __) => const SizedBox(width: 12),
                itemBuilder: (context, i) {
                  final category = categories[i];
                  return _CategoryCard(
                    category: category,
                    quote: quotes[category],
                    isSelected: category == selected,
                    isLoading: isQuoting && quotes[category] == null,
                    onTap: () => onSelect(category),
                  );
                },
              ),
            ),

            const SizedBox(height: 16),

            // --- Fare + surge notice --------------------------------
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          l10n.translate('rider.estimated_fare'),
                          style: theme.textTheme.bodySmall,
                        ),
                        const SizedBox(height: 2),
                        // The number never shows a spinner in place: a stale
                        // price with a subtle loading tint beats a blank box.
                        AnimatedOpacity(
                          opacity: isQuoting ? 0.45 : 1.0,
                          duration: const Duration(milliseconds: 180),
                          child: Text(
                            quote == null
                                ? '—'
                                : formatTzs(quote.totalFareCents),
                            style: theme.textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (quote != null && quote.surgeMultiplier > 1.0)
                    _SurgeChip(multiplier: quote.surgeMultiplier),
                ],
              ),
            ),

            const SizedBox(height: 12),

            // --- Request button -------------------------------------
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton(
                  onPressed: canRequest && !isRequesting ? onRequest : null,
                  style: FilledButton.styleFrom(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: isRequesting
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.4,
                            color: Colors.white,
                          ),
                        )
                      : Text(
                          l10n.translate(
                            'rider.request_ride',
                            params: {'category': l10n.categoryName(selected)},
                          ),
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.category,
    required this.quote,
    required this.isSelected,
    required this.isLoading,
    required this.onTap,
  });

  final VehicleCategory category;
  final FareQuote? quote;
  final bool isSelected;
  final bool isLoading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return Semantics(
      selected: isSelected,
      button: true,
      label: l10n.categoryName(category),
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 116,
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
          decoration: BoxDecoration(
            color: isSelected
                ? theme.colorScheme.primary.withOpacity(0.10)
                : theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: isSelected ? theme.colorScheme.primary : Colors.transparent,
              width: 2,
            ),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Image.asset(category.assetPath, height: 40, fit: BoxFit.contain),
              const SizedBox(height: 8),
              Text(
                l10n.categoryName(category),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelLarge?.copyWith(
                  fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                ),
              ),
              const SizedBox(height: 4),
              if (isLoading)
                const SizedBox(
                  height: 14,
                  width: 40,
                  child: LinearProgressIndicator(minHeight: 3),
                )
              else
                Text(
                  quote == null ? '—' : formatTzsCompact(quote.totalFareCents),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              const SizedBox(height: 2),
              Text(
                quote == null
                    ? ''
                    : l10n.translate('rider.eta_min',
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

class _SurgeChip extends StatelessWidget {
  const _SurgeChip({required this.multiplier});
  final double multiplier;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF3E0),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.trending_up, size: 16, color: Color(0xFFE65100)),
          const SizedBox(width: 6),
          Text(
            // Stating the reason, not just the number, cuts complaints:
            // "high demand ×1.2" rather than a bare multiplier.
            l10n.translate('rider.surge_active',
                params: {'x': multiplier.toStringAsFixed(1)}),
            style: const TextStyle(
              color: Color(0xFFE65100),
              fontWeight: FontWeight.w600,
              fontSize: 13,
            ),
          ),
        ],
      ),
    );
  }
}

class _DestinationBar extends StatelessWidget {
  const _DestinationBar({required this.destination});
  final String? destination;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Material(
        elevation: 3,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => Navigator.of(context).pushNamed('/search-destination'),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            child: Row(
              children: [
                const Icon(Icons.search, size: 22),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    destination ?? l10n.translate('rider.where_to'),
                    style: TextStyle(
                      fontSize: 16,
                      color: destination == null ? Colors.black54 : Colors.black87,
                      fontWeight:
                          destination == null ? FontWeight.w400 : FontWeight.w600,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PickupPin extends StatelessWidget {
  const _PickupPin();

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: Colors.black87,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            AppLocalizations.of(context).translate('rider.pickup_here'),
            style: const TextStyle(color: Colors.white, fontSize: 12),
          ),
        ),
        const SizedBox(height: 4),
        const Icon(Icons.location_on, size: 44, color: Color(0xFF1B5E20)),
      ],
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});
  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xFFB3261E),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 6, 12),
        child: Row(
          children: [
            Expanded(
              child: Text(message,
                  style: const TextStyle(color: Colors.white, fontSize: 14)),
            ),
            IconButton(
              icon: const Icon(Icons.close, color: Colors.white, size: 20),
              onPressed: onDismiss,
            ),
          ],
        ),
      ),
    );
  }
}
