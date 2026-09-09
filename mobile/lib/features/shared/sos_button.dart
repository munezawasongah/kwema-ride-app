/// Emergency SOS.
///
/// Behaviour is shaped by two opposing risks: a button that fires by accident
/// wastes an operator's night, and a button that is hard to reach fails the
/// person it exists for. The resolution is a press-and-hold — deliberate
/// enough that a pocket cannot trigger it, fast enough to use one-handed
/// under stress — rather than a confirmation dialog someone has to read.
///
/// Once raised, the sheet stays open with the emergency number one tap away.
/// Tanzania's 112 does not connect reliably outside the larger cities, so the
/// alert also reaches Kwema operations and the person's own contact; the sheet
/// says so plainly rather than implying help is guaranteed.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';

const String kEmergencyNumber = '112';

class SosButton extends ConsumerStatefulWidget {
  const SosButton({super.key, this.rideId, this.compact = false});

  /// Attached to the trip when there is one, so operations see the route,
  /// the vehicle and the other party without looking anything up.
  final String? rideId;
  final bool compact;

  @override
  ConsumerState<SosButton> createState() => _SosButtonState();
}

class _SosButtonState extends ConsumerState<SosButton> {
  static const _holdDuration = Duration(milliseconds: 900);

  Timer? _timer;
  double _progress = 0;
  bool _sending = false;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startHold() {
    if (_sending) return;
    HapticFeedback.selectionClick();
    const tick = Duration(milliseconds: 30);
    _timer?.cancel();
    _timer = Timer.periodic(tick, (t) {
      setState(() {
        _progress += tick.inMilliseconds / _holdDuration.inMilliseconds;
      });
      if (_progress >= 1) {
        t.cancel();
        _fire();
      }
    });
  }

  void _cancelHold() {
    _timer?.cancel();
    if (!_sending) setState(() => _progress = 0);
  }

  Future<void> _fire() async {
    setState(() { _sending = true; _progress = 1; });
    HapticFeedback.heavyImpact();

    // A missing fix must never stop the alarm, so the location attempt is
    // time-boxed and its failure ignored.
    double? lat, lng;
    int? accuracy;
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 4),
        ),
      );
      lat = pos.latitude;
      lng = pos.longitude;
      accuracy = pos.accuracy.round();
    } catch (_) {
      try {
        final last = await Geolocator.getLastKnownPosition();
        lat = last?.latitude;
        lng = last?.longitude;
      } catch (_) { /* proceed without a location */ }
    }

    String message;
    try {
      final res = await ref.read(apiClientProvider).post('/sos', {
        if (widget.rideId != null) 'rideId': widget.rideId,
        if (lat != null) 'lat': lat,
        if (lng != null) 'lng': lng,
        if (accuracy != null) 'accuracyM': accuracy,
      });
      message = (res as Map)['message']?.toString() ?? '';
    } catch (_) {
      // Even a failed request gets an honest answer and the number to call.
      message = '';
    }

    if (!mounted) return;
    setState(() { _sending = false; _progress = 0; });
    await _showRaisedSheet(message, lat != null);
  }

  Future<void> _showRaisedSheet(String serverMessage, bool hadLocation) {
    final l10n = AppLocalizations.of(context);
    return showModalBottomSheet<void>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 28, 24, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.shield, size: 48, color: Color(0xFFC0392B)),
            const SizedBox(height: 14),
            Text(l10n.translate('sos.sent_title'),
                style: Theme.of(ctx).textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w800),
                textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(
              hadLocation
                  ? l10n.translate('sos.sent_body')
                  : l10n.translate('sos.sent_no_location'),
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.bodyMedium,
            ),
            const SizedBox(height: 22),
            SizedBox(
              width: double.infinity,
              height: 60,
              child: FilledButton.icon(
                style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFFC0392B)),
                icon: const Icon(Icons.call),
                label: Text(
                  l10n.translate('sos.call', params: {'n': kEmergencyNumber}),
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                ),
                onPressed: () =>
                    launchUrl(Uri.parse('tel:$kEmergencyNumber')),
              ),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(l10n.translate('common.close')),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final holding = _progress > 0 && _progress < 1;

    return Semantics(
      button: true,
      label: l10n.translate('sos.hold'),
      child: GestureDetector(
        onTapDown: (_) => _startHold(),
        onTapUp: (_) => _cancelHold(),
        onTapCancel: _cancelHold,
        child: Container(
          height: widget.compact ? 44 : 52,
          padding: EdgeInsets.symmetric(horizontal: widget.compact ? 14 : 20),
          decoration: BoxDecoration(
            color: const Color(0xFFC0392B),
            borderRadius: BorderRadius.circular(widget.compact ? 12 : 14),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              // Fills as the hold progresses, so the person can see how long
              // is left rather than guessing whether it registered.
              if (holding)
                Positioned.fill(
                  child: FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: _progress.clamp(0, 1),
                    child: Container(
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.28),
                        borderRadius:
                            BorderRadius.circular(widget.compact ? 12 : 14),
                      ),
                    ),
                  ),
                ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_sending)
                    const SizedBox(
                      width: 18, height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: Colors.white))
                  else
                    const Icon(Icons.shield_outlined,
                        color: Colors.white, size: 20),
                  const SizedBox(width: 9),
                  Text(
                    _sending
                        ? l10n.translate('sos.sending')
                        : holding
                            ? l10n.translate('sos.keep_holding')
                            : l10n.translate('sos.label'),
                    style: TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w800,
                      fontSize: widget.compact ? 14 : 16,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
