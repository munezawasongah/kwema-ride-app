/// Incoming ride offer modal for the driver app.
///
/// Constraints this design answers:
///  * The driver is usually moving, often on a bodaboda, and has ~15 seconds.
///    So: two enormous targets, the accept action on the right where a thumb
///    naturally lands, and no scrolling.
///  * The countdown must be driven by the *server's* expiry timestamp, not a
///    local 15-second tick. A backgrounded app or a stalled socket otherwise
///    shows time remaining on an offer that has already been reassigned.
///  * A double-tap must not fire two accepts. The button latches on first
///    press and only unlatches on a failed claim.
///  * Sound and vibration fire once, on show, and are cancelled on dismiss —
///    a phone that keeps buzzing after the offer is gone erodes trust fast.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/format/tzs.dart';
import '../../core/l10n/localization.dart';
import '../../core/models/models.dart';

class IncomingRideModal extends StatefulWidget {
  const IncomingRideModal({
    super.key,
    required this.offer,
    required this.onAccept,
    required this.onDecline,
    required this.onExpire,
  });

  final RideOffer offer;

  /// Returns true if the claim succeeded. False means another driver won it,
  /// in which case the modal shows a brief "taken" state and closes itself.
  final Future<bool> Function() onAccept;
  final Future<void> Function(String? reason) onDecline;
  final VoidCallback onExpire;

  /// Convenience entry point. Non-dismissible: an offer is answered or it
  /// times out; a stray back-swipe must not silently decline it.
  static Future<void> show(
    BuildContext context, {
    required RideOffer offer,
    required Future<bool> Function() onAccept,
    required Future<void> Function(String? reason) onDecline,
    required VoidCallback onExpire,
  }) {
    return showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: Colors.black.withOpacity(0.72),
      builder: (_) => PopScope(
        canPop: false,
        child: IncomingRideModal(
          offer: offer,
          onAccept: onAccept,
          onDecline: onDecline,
          onExpire: onExpire,
        ),
      ),
    );
  }

  @override
  State<IncomingRideModal> createState() => _IncomingRideModalState();
}

class _IncomingRideModalState extends State<IncomingRideModal> {
  Timer? _tick;
  Duration _remaining = Duration.zero;
  bool _submitting = false;
  bool _taken = false;

  @override
  void initState() {
    super.initState();
    _remaining = _computeRemaining();
    _startCountdown();
    _alertDriver();
  }

  /// Derived from the server's absolute expiry, so a paused or backgrounded
  /// app shows the truth the moment it resumes.
  Duration _computeRemaining() {
    final left = widget.offer.expiresAt.difference(DateTime.now());
    return left.isNegative ? Duration.zero : left;
  }

  void _startCountdown() {
    _tick = Timer.periodic(const Duration(milliseconds: 200), (_) {
      final remaining = _computeRemaining();
      if (!mounted) return;
      setState(() => _remaining = remaining);

      if (remaining <= Duration.zero) {
        _tick?.cancel();
        _dismiss();
        widget.onExpire();
      }
    });
  }

  void _alertDriver() {
    // One assertive pattern, then silence. Repeating alerts while the driver
    // is riding are a genuine safety problem.
    HapticFeedback.heavyImpact();
    Future.delayed(const Duration(milliseconds: 220), HapticFeedback.mediumImpact);
    SystemSound.play(SystemSoundType.alert);
  }

  Future<void> _handleAccept() async {
    if (_submitting) return; // latch against double-tap
    setState(() => _submitting = true);
    HapticFeedback.selectionClick();

    final won = await widget.onAccept();
    if (!mounted) return;

    if (won) {
      _dismiss();
    } else {
      // Lost the race. Say so plainly and get out of the way rather than
      // leaving a dead button on screen.
      setState(() {
        _taken = true;
        _submitting = false;
      });
      _tick?.cancel();
      await Future.delayed(const Duration(milliseconds: 1100));
      if (mounted) _dismiss();
    }
  }

  Future<void> _handleDecline() async {
    if (_submitting) return;
    setState(() => _submitting = true);
    await widget.onDecline(null);
    if (mounted) _dismiss();
  }

  void _dismiss() {
    _tick?.cancel();
    if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final offer = widget.offer;

    final totalSeconds = offer.ttlSeconds.toDouble();
    final progress =
        totalSeconds <= 0 ? 0.0 : (_remaining.inMilliseconds / 1000) / totalSeconds;
    final secondsLeft = _remaining.inSeconds;
    final isUrgent = secondsLeft <= 5;

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // --- Countdown ring ------------------------------------
            SizedBox(
              width: 96,
              height: 96,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  SizedBox.expand(
                    child: TweenAnimationBuilder<double>(
                      tween: Tween(begin: progress, end: progress),
                      duration: const Duration(milliseconds: 200),
                      builder: (_, value, __) => CircularProgressIndicator(
                        value: value.clamp(0.0, 1.0),
                        strokeWidth: 7,
                        backgroundColor: theme.dividerColor,
                        valueColor: AlwaysStoppedAnimation(
                          isUrgent
                              ? const Color(0xFFB3261E)
                              : theme.colorScheme.primary,
                        ),
                      ),
                    ),
                  ),
                  Text(
                    '$secondsLeft',
                    style: theme.textTheme.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      color: isUrgent ? const Color(0xFFB3261E) : null,
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 14),

            Text(
              l10n.translate('driver.new_request'),
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),

            // Earnings up front. It is the first thing every driver looks at,
            // and burying it costs acceptance rate.
            Text(
              formatTzs(offer.driverEarningsCents),
              style: theme.textTheme.headlineMedium?.copyWith(
                fontWeight: FontWeight.w800,
                color: const Color(0xFF1B5E20),
              ),
            ),
            if (offer.surgeMultiplier > 1.0) ...[
              const SizedBox(height: 4),
              Text(
                l10n.translate('driver.surge_bonus',
                    params: {'x': offer.surgeMultiplier.toStringAsFixed(1)}),
                style: const TextStyle(
                  color: Color(0xFFE65100),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],

            const SizedBox(height: 16),

            // --- Trip shape -----------------------------------------
            _TripLeg(
              icon: Icons.my_location,
              iconColour: const Color(0xFF1B5E20),
              label: l10n.translate('driver.pickup'),
              address: offer.pickupAddress,
              trailing: l10n.translate('driver.away',
                  params: {'d': _formatDistance(offer.distanceToPickupM)}),
            ),
            const Padding(
              padding: EdgeInsets.only(left: 11),
              child: SizedBox(
                height: 18,
                child: VerticalDivider(width: 2, thickness: 2),
              ),
            ),
            _TripLeg(
              icon: Icons.location_on,
              iconColour: const Color(0xFFB3261E),
              label: l10n.translate('driver.dropoff'),
              address: offer.dropoffAddress,
              trailing: _formatDistance(offer.tripDistanceM),
            ),

            const SizedBox(height: 12),

            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _Stat(
                  icon: Icons.timer_outlined,
                  value: l10n.translate('driver.eta_min',
                      params: {'min': '${(offer.etaToPickupSeconds / 60).ceil()}'}),
                  label: l10n.translate('driver.to_pickup'),
                ),
                _Stat(
                  icon: Icons.star_rounded,
                  value: offer.riderRating.toStringAsFixed(1),
                  label: l10n.translate('driver.rider_rating'),
                ),
                _Stat(
                  icon: offer.paymentMethod == 'cash'
                      ? Icons.payments_outlined
                      : Icons.smartphone,
                  value: l10n.translate('payment.${offer.paymentMethod}'),
                  label: l10n.translate('driver.payment'),
                ),
              ],
            ),

            const SizedBox(height: 18),

            if (_taken)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 16),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  l10n.translate('driver.offer_taken'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              )
            else
              Row(
                children: [
                  Expanded(
                    flex: 2,
                    child: SizedBox(
                      height: 60,
                      child: OutlinedButton(
                        onPressed: _submitting ? null : _handleDecline,
                        style: OutlinedButton.styleFrom(
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                        child: Text(
                          l10n.translate('driver.decline'),
                          style: const TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 3,
                    child: SizedBox(
                      height: 60,
                      child: FilledButton(
                        onPressed: _submitting ? null : _handleAccept,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF1B5E20),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                        child: _submitting
                            ? const SizedBox(
                                width: 24,
                                height: 24,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  color: Colors.white,
                                ),
                              )
                            : Text(
                                l10n.translate('driver.accept'),
                                style: const TextStyle(
                                    fontSize: 18, fontWeight: FontWeight.w700),
                              ),
                      ),
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  String _formatDistance(int metres) {
    if (metres < 1000) return '$metres m';
    return '${(metres / 1000).toStringAsFixed(1)} km';
  }
}

class _TripLeg extends StatelessWidget {
  const _TripLeg({
    required this.icon,
    required this.iconColour,
    required this.label,
    required this.address,
    required this.trailing,
  });

  final IconData icon;
  final Color iconColour;
  final String label;
  final String address;
  final String trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 22, color: iconColour),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: theme.textTheme.bodySmall),
              Text(
                address,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Text(trailing,
            style: theme.textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w600)),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.icon, required this.value, required this.label});
  final IconData icon;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Icon(icon, size: 20, color: theme.colorScheme.outline),
        const SizedBox(height: 4),
        Text(value,
            style: theme.textTheme.bodyMedium
                ?.copyWith(fontWeight: FontWeight.w700)),
        Text(label, style: theme.textTheme.bodySmall),
      ],
    );
  }
}
