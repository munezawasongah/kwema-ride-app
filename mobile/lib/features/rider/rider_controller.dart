/// Rider state: destination search, quoting, requesting, live tracking.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../core/models/models.dart';
import '../../core/network/api_client.dart';
import '../../core/network/session_store.dart';
import '../../core/network/socket_client.dart';

class RiderState {
  const RiderState({
    this.pickup,
    this.dropoff,
    this.pickupLabel,
    this.dropoffLabel,
    this.quotes = const [],
    this.selected,
    this.ride,
    this.driverPosition,
    this.suggestions = const [],
    this.isQuoting = false,
    this.isRequesting = false,
    this.errorKey,
    this.paymentMethod = 'cash',
  });

  final LatLng? pickup;
  final LatLng? dropoff;
  final String? pickupLabel;
  final String? dropoffLabel;
  final List<FareQuote> quotes;
  final FareQuote? selected;
  final Ride? ride;
  final LatLng? driverPosition;
  final List<PlaceSuggestion> suggestions;
  final bool isQuoting;
  final bool isRequesting;
  final String? errorKey;
  final String paymentMethod;

  bool get canRequest =>
      pickup != null && dropoff != null && selected != null && ride == null;

  bool get hasActiveRide => ride != null && !ride!.status.isTerminal;

  RiderState copyWith({
    LatLng? pickup, LatLng? dropoff, String? pickupLabel, String? dropoffLabel,
    List<FareQuote>? quotes, FareQuote? selected, Ride? ride,
    LatLng? driverPosition, List<PlaceSuggestion>? suggestions,
    bool? isQuoting, bool? isRequesting, String? errorKey, String? paymentMethod,
    bool clearRide = false, bool clearError = false,
  }) => RiderState(
        pickup: pickup ?? this.pickup,
        dropoff: dropoff ?? this.dropoff,
        pickupLabel: pickupLabel ?? this.pickupLabel,
        dropoffLabel: dropoffLabel ?? this.dropoffLabel,
        quotes: quotes ?? this.quotes,
        selected: selected ?? this.selected,
        ride: clearRide ? null : (ride ?? this.ride),
        driverPosition: driverPosition ?? this.driverPosition,
        suggestions: suggestions ?? this.suggestions,
        isQuoting: isQuoting ?? this.isQuoting,
        isRequesting: isRequesting ?? this.isRequesting,
        errorKey: clearError ? null : (errorKey ?? this.errorKey),
        paymentMethod: paymentMethod ?? this.paymentMethod,
      );
}

class RiderController extends StateNotifier<RiderState> {
  RiderController(this._api, this._socket) : super(const RiderState()) {
    _listen();
    unawaited(_socket.connect());
    unawaited(locateMe());
  }

  final ApiClient _api;
  final SocketClient _socket;
  final List<StreamSubscription<dynamic>> _subs = [];

  /// Places session token. Google bills autocomplete per session rather than
  /// per keystroke when this is supplied, and a rider typing "Mlimani"
  /// generates seven requests.
  String _placesSession = DateTime.now().millisecondsSinceEpoch.toString();

  Timer? _debounce;

  void _listen() {
    _subs.add(_socket.rideStatus.listen((data) {
      final status = data['status']?.toString();
      if (status == null) return;

      final current = state.ride;
      final updated = current == null
          ? Ride.fromJson(data)
          : current.copyWith(
              status: RideStatus.fromWire(status),
              driver: data['driver'] == null
                  ? null
                  : DriverProfile.fromJson(
                      (data['driver'] as Map).cast<String, dynamic>()),
              vehicle: data['vehicle'] == null
                  ? null
                  : VehicleInfo.fromJson(
                      (data['vehicle'] as Map).cast<String, dynamic>()),
              etaSeconds: (data['etaSeconds'] as num?)?.toInt(),
              finalFareCents: (data['fareCents'] as num?)?.toInt(),
            );
      state = state.copyWith(ride: updated, isRequesting: false);
    }));

    _subs.add(_socket.driverMoved.listen((data) {
      final la = data['la'], ln = data['ln'];
      if (la is num && ln is num) {
        state = state.copyWith(
            driverPosition: LatLng(la / 1e6, ln / 1e6));
      }
    }));

    _subs.add(_socket.payments.listen((data) {
      if (data['status'] == 'success' && state.ride != null) {
        state = state.copyWith(ride: state.ride!.copyWith(isPaid: true));
      }
    }));
  }

  // -----------------------------------------------------------------

  Future<void> locateMe() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        state = state.copyWith(errorKey: 'error.gps_off');
        return;
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        state = state.copyWith(errorKey: 'error.location_denied');
        return;
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 12)),
      );
      final point = LatLng(pos.latitude, pos.longitude);
      state = state.copyWith(pickup: point, clearError: true);

      // Reverse geocode is a hint only. Large parts of Dar have no street
      // addresses in Google's data, so this often returns something as broad
      // as "Kinondoni" — useful to show, not to rely on.
      final res = await _api.get('/maps/reverse-geocode',
          query: {'lat': pos.latitude, 'lng': pos.longitude});
      final address = (res as Map)['address']?.toString();
      if (address != null) state = state.copyWith(pickupLabel: address);
    } catch (_) {
      // A missing pickup label is survivable; the map marker still works.
    }
  }

  void searchPlaces(String input) {
    _debounce?.cancel();
    if (input.trim().length < 2) {
      state = state.copyWith(suggestions: const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      try {
        final res = await _api.post('/maps/autocomplete', {
          'input': input,
          'sessionToken': _placesSession,
          if (state.pickup != null) 'lat': state.pickup!.latitude,
          if (state.pickup != null) 'lng': state.pickup!.longitude,
        });
        final list = (res as List)
            .map((e) => PlaceSuggestion.fromJson(
                (e as Map).cast<String, dynamic>()))
            .toList();
        state = state.copyWith(suggestions: list);
      } catch (_) {
        state = state.copyWith(suggestions: const []);
      }
    });
  }

  Future<void> chooseDestination(PlaceSuggestion suggestion) async {
    try {
      final res = await _api.get('/maps/place', query: {
        'placeId': suggestion.placeId,
        'sessionToken': _placesSession,
      });
      final map = (res as Map).cast<String, dynamic>();
      final point = (map['point'] as Map).cast<String, dynamic>();

      state = state.copyWith(
        dropoff: LatLng((point['lat'] as num).toDouble(),
            (point['lng'] as num).toDouble()),
        dropoffLabel: suggestion.primary,
        suggestions: const [],
      );

      // A new session token per completed selection: that is what closes the
      // billing session on Google's side.
      _placesSession = DateTime.now().millisecondsSinceEpoch.toString();
      await refreshQuote();
    } catch (_) {
      state = state.copyWith(errorKey: 'error.network');
    }
  }

  void setPickup(LatLng point) => state = state.copyWith(pickup: point);

  void selectCategory(VehicleCategory category) {
    final match = state.quotes.where((q) => q.category == category);
    if (match.isNotEmpty) state = state.copyWith(selected: match.first);
  }

  void setPaymentMethod(String method) =>
      state = state.copyWith(paymentMethod: method);

  Future<void> refreshQuote() async {
    if (state.pickup == null || state.dropoff == null) return;
    state = state.copyWith(isQuoting: true, clearError: true);

    try {
      final res = await _api.post('/pricing/quote', {
        'pickupLat': state.pickup!.latitude,
        'pickupLng': state.pickup!.longitude,
        'dropoffLat': state.dropoff!.latitude,
        'dropoffLng': state.dropoff!.longitude,
      });
      final quotes = ((res as Map)['quotes'] as List)
          .map((e) => FareQuote.fromJson((e as Map).cast<String, dynamic>()))
          .toList();

      final keep = state.selected == null
          ? null
          : quotes.where((q) => q.category == state.selected!.category);

      state = state.copyWith(
        quotes: quotes,
        selected: (keep != null && keep.isNotEmpty)
            ? keep.first
            : quotes.where((q) => q.category == VehicleCategory.standard)
                .followedBy(quotes).first,
        isQuoting: false,
      );
    } on ApiException catch (e) {
      state = state.copyWith(isQuoting: false, errorKey: e.message);
    }
  }

  Future<void> requestRide() async {
    final quote = state.selected;
    if (quote == null || state.pickup == null || state.dropoff == null) return;

    // A stale quote is refused by the server, so re-quote rather than send it.
    if (quote.isExpired) {
      await refreshQuote();
      state = state.copyWith(errorKey: 'error.quote_expired');
      return;
    }

    state = state.copyWith(isRequesting: true, clearError: true);
    try {
      final res = await _api.post('/rides/request', {
        // Idempotency key: a retry after a dropped ack returns the same ride
        // rather than creating a second one.
        'clientGeneratedId': _uuid(),
        'quoteId': quote.quoteId,
        'category': quote.category.wire,
        'paymentMethod': state.paymentMethod,
        'pickup': {
          'lat': state.pickup!.latitude,
          'lng': state.pickup!.longitude,
          'address': state.pickupLabel,
        },
        'dropoff': {
          'lat': state.dropoff!.latitude,
          'lng': state.dropoff!.longitude,
          'address': state.dropoffLabel,
        },
      });
      state = state.copyWith(
          ride: Ride.fromJson((res as Map).cast<String, dynamic>()));
    } on ApiException catch (e) {
      state = state.copyWith(isRequesting: false, errorKey: e.message);
    }
  }

  Future<void> cancelRide() async {
    final ride = state.ride;
    if (ride == null) return;
    try {
      await _api.post('/rides/${ride.id}/cancel', {});
      state = state.copyWith(clearRide: true, quotes: const []);
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
    }
  }

  Future<String?> payNow({String mno = 'mpesa'}) async {
    final ride = state.ride;
    if (ride == null) return null;
    try {
      if (state.paymentMethod == 'card') {
        final res = await _api.post('/payments/card/initiate', {'rideId': ride.id});
        // Returns a hosted checkout URL. Card fields are entered on the
        // provider's page in a WebView, never in this app.
        return (res as Map)['checkoutUrl']?.toString();
      }
      await _api.post('/payments/collect', {'rideId': ride.id, 'mno': mno});
      return null;
    } on ApiException catch (e) {
      state = state.copyWith(errorKey: e.message);
      return null;
    }
  }

  void dismissRide() =>
      state = state.copyWith(clearRide: true, quotes: const []);

  void clearError() => state = state.copyWith(clearError: true);

  String _uuid() {
    final now = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
    final rand = (DateTime.now().hashCode ^ hashCode).toRadixString(16);
    return '$now-$rand';
  }

  @override
  void dispose() {
    _debounce?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }
}

final socketClientProvider = Provider<SocketClient>((ref) {
  final client = SocketClient(ref.watch(sessionStoreProvider));
  ref.onDispose(client.dispose);
  return client;
});

final riderControllerProvider =
    StateNotifierProvider<RiderController, RiderState>((ref) {
  return RiderController(
    ref.watch(apiClientProvider),
    ref.watch(socketClientProvider),
  );
});
