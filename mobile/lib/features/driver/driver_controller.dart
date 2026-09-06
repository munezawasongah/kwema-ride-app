/// Driver state: online/offline, offers, trip lifecycle, earnings.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/location/offline_location_queue.dart';
import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/network/session_store.dart';
import '../../core/network/socket_client.dart';
import '../rider/rider_controller.dart' show socketClientProvider;

class DriverState {
  const DriverState({
    this.isOnline = false,
    this.position,
    this.offer,
    this.activeRide,
    this.tripsToday = 0,
    this.earnedTodayCents = 0,
    this.walletBalanceCents = 0,
    this.debtCeilingCents = 3000000,
    this.isBlocked = false,
    this.busy = false,
    this.errorKey,
  });

  final bool isOnline;
  final LatLng? position;
  final RideOffer? offer;
  final Ride? activeRide;
  final int tripsToday;
  final int earnedTodayCents;

  /// Negative means commission owed on cash trips.
  final int walletBalanceCents;
  final int debtCeilingCents;

  /// True when unsettled cash commission has hit the ceiling; dispatch stops
  /// sending offers until it is cleared.
  final bool isBlocked;

  final bool busy;
  final String? errorKey;

  int get debtCents => walletBalanceCents < 0 ? -walletBalanceCents : 0;

  DriverState copyWith({
    bool? isOnline, LatLng? position, RideOffer? offer, Ride? activeRide,
    int? tripsToday, int? earnedTodayCents, int? walletBalanceCents,
    int? debtCeilingCents, bool? isBlocked, bool? busy, String? errorKey,
    bool clearOffer = false, bool clearRide = false, bool clearError = false,
  }) => DriverState(
        isOnline: isOnline ?? this.isOnline,
        position: position ?? this.position,
        offer: clearOffer ? null : (offer ?? this.offer),
        activeRide: clearRide ? null : (activeRide ?? this.activeRide),
        tripsToday: tripsToday ?? this.tripsToday,
        earnedTodayCents: earnedTodayCents ?? this.earnedTodayCents,
        walletBalanceCents: walletBalanceCents ?? this.walletBalanceCents,
        debtCeilingCents: debtCeilingCents ?? this.debtCeilingCents,
        isBlocked: isBlocked ?? this.isBlocked,
        busy: busy ?? this.busy,
        errorKey: clearError ? null : (errorKey ?? this.errorKey),
      );
}

class DriverController extends StateNotifier<DriverState> {
  DriverController(this._api, this._socket) : super(const DriverState()) {
    _listen();
    unawaited(_socket.connect());
    unawaited(refreshWallet());
  }

  final ApiClient _api;
  final SocketClient _socket;
  final List<StreamSubscription<dynamic>> _subs = [];
  OfflineLocationQueue? _queue;

  void _listen() {
    _subs.add(_socket.offers.listen((data) {
      // ride:offer_closed arrives when another driver won the race.
      if (data.containsKey('reason')) {
        state = state.copyWith(clearOffer: true);
        return;
      }
      if (data['rideId'] == null) return;
      state = state.copyWith(offer: RideOffer.fromJson(data));
    }));

    _subs.add(_socket.rideStatus.listen((data) {
      final status = data['status']?.toString();
      if (status == null) return;
      final ride = state.activeRide;
      if (ride == null) return;
      state = state.copyWith(
          activeRide: ride.copyWith(status: RideStatus.fromWire(status)));
    }));
  }

  // -----------------------------------------------------------------
  // Going online
  // -----------------------------------------------------------------

  Future<void> goOnline() async {
    if (state.isBlocked) {
      state = state.copyWith(errorKey: 'driver.debt_warning');
      return;
    }
    state = state.copyWith(busy: true, clearError: true);

    try {
      final db = await OfflineLocationQueue.openBuffer();
      _queue = OfflineLocationQueue(_socket, db);
      await _queue!.start();

      // Position stream also drives the map marker, so the UI reflects what
      // the server is being told rather than a separate reading.
      _subs.add(Geolocator.getPositionStream(
        locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high, distanceFilter: 10),
      ).listen((pos) {
        state = state.copyWith(position: LatLng(pos.latitude, pos.longitude));
      }));

      state = state.copyWith(isOnline: true, busy: false);
    } catch (e) {
      state = state.copyWith(
        busy: false,
        errorKey: e.toString().contains('permission')
            ? 'error.location_denied'
            : 'error.gps_off',
      );
    }
  }

  Future<void> goOffline() async {
    await _queue?.stop();
    _queue = null;
    state = state.copyWith(isOnline: false, clearOffer: true);
  }

  // -----------------------------------------------------------------
  // Offers
  // -----------------------------------------------------------------

  /// Returns true if this driver won the ride. False means another driver
  /// accepted first — a routine race, not an error.
  Future<bool> acceptOffer() async {
    final offer = state.offer;
    if (offer == null) return false;

    final reply = await _socket.emitWithAck('ride:accept', {
      'rideId': offer.rideId,
      // The offer token proves this driver was actually offered the ride;
      // without it, a replayed ride id would be enough to claim one.
      'offerToken': offer.offerToken,
    });

    final won = reply is Map && reply['ok'] == true;
    if (won) {
      state = state.copyWith(
        clearOffer: true,
        activeRide: Ride(
          id: offer.rideId,
          reference: '',
          status: RideStatus.accepted,
          category: VehicleCategory.standard,
          quotedFareCents: offer.fareCents,
          paymentMethod: offer.paymentMethod,
          isPaid: false,
        ),
      );
    } else {
      state = state.copyWith(clearOffer: true);
    }
    return won;
  }

  Future<void> declineOffer([String? reason]) async {
    final offer = state.offer;
    if (offer == null) return;
    _socket.emit('ride:decline', {'rideId': offer.rideId, 'reason': reason});
    state = state.copyWith(clearOffer: true);
  }

  void offerExpired() => state = state.copyWith(clearOffer: true);

  // -----------------------------------------------------------------
  // Trip lifecycle
  // -----------------------------------------------------------------

  Future<void> markArrived() => _transition('arrived');
  Future<void> startTrip() => _transition('in_progress');
  Future<void> completeTrip() => _transition('completed');

  Future<void> _transition(String status) async {
    final ride = state.activeRide;
    if (ride == null) return;
    state = state.copyWith(busy: true);

    // Sent over the socket so the rider's app updates immediately; the
    // server validates the transition and computes the fare itself.
    _socket.emit('ride:status_change', {
      'rideId': ride.id,
      'status': status,
      'at': DateTime.now().millisecondsSinceEpoch,
    });

    if (status == 'in_progress') _queue?.setActiveRide(ride.id);
    if (status == 'completed') {
      _queue?.setActiveRide(null);
      state = state.copyWith(
        tripsToday: state.tripsToday + 1,
        earnedTodayCents: state.earnedTodayCents + ride.payableCents,
      );
      await refreshWallet();
    }
    state = state.copyWith(busy: false);
  }

  /// Cash trips only. Commission is booked against the wallet at this point,
  /// not automatically on completion — a rider who leaves without paying is
  /// a real occurrence, and auto-booking would bill the driver for money
  /// they never received.
  Future<void> confirmCashCollected() async {
    final ride = state.activeRide;
    if (ride == null) return;
    try {
      await _api.post('/payments/cash/confirm', {'rideId': ride.id});
      state = state.copyWith(clearRide: true);
      await refreshWallet();
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
    }
  }

  void dismissTrip() => state = state.copyWith(clearRide: true);

  Future<void> refreshWallet() async {
    try {
      final res = await _api.get('/payments/cash/balance');
      final map = (res as Map).cast<String, dynamic>();
      state = state.copyWith(
        walletBalanceCents: (map['balanceCents'] as num?)?.toInt() ?? 0,
        debtCeilingCents: (map['ceilingCents'] as num?)?.toInt() ?? 3000000,
        isBlocked: map['isBlocked'] == true,
      );
    } catch (_) {
      // Wallet is informational here; a failed refresh must not block work.
    }
  }

  void clearError() => state = state.copyWith(clearError: true);

  @override
  void dispose() {
    unawaited(_queue?.stop());
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}

final driverControllerProvider =
    StateNotifierProvider<DriverController, DriverState>((ref) {
  return DriverController(
    ref.watch(apiClientProvider),
    ref.watch(socketClientProvider),
  );
});
