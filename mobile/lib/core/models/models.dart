/// Wire models.
///
/// Hand-written rather than code-generated: json_serializable would add a
/// build step and generated files to a project that has fewer than a dozen
/// models, and the server's field names are stable.
///
/// Every money field is integer cents. Every `fromJson` tolerates nulls and
/// string-encoded numbers, because Postgres BIGINT columns arrive as strings
/// through some driver paths and a crash on parse would take out the app.

import 'package:flutter/material.dart';

int _int(dynamic v, [int fallback = 0]) {
  if (v == null) return fallback;
  if (v is int) return v;
  if (v is double) return v.round();
  return int.tryParse(v.toString()) ?? fallback;
}

double _double(dynamic v, [double fallback = 0]) {
  if (v == null) return fallback;
  if (v is num) return v.toDouble();
  return double.tryParse(v.toString()) ?? fallback;
}

// =====================================================================
// Vehicle category
// =====================================================================

enum VehicleCategory {
  boda('boda', Color(0xFFD9722B), 'assets/vehicles/boda.png'),
  bajaji('bajaji', Color(0xFFC9A227), 'assets/vehicles/bajaji.png'),
  standard('standard', Color(0xFF3A4BB8), 'assets/vehicles/car.png'),
  xl('xl', Color(0xFF2E7D74), 'assets/vehicles/xl.png'),
  express('express', Color(0xFF30409B), 'assets/vehicles/express.png');

  const VehicleCategory(this.wire, this.colour, this.assetPath);

  /// Value used on the wire and in the database enum.
  final String wire;

  /// Tier colour. Riders with limited literacy recognise the tile by colour
  /// before reading it, so this is functional rather than decorative.
  final Color colour;

  final String assetPath;

  static VehicleCategory fromWire(String? value) =>
      VehicleCategory.values.firstWhere(
        (c) => c.wire == value,
        orElse: () => VehicleCategory.standard,
      );
}

// =====================================================================
// Fare
// =====================================================================

class FareBreakdown {
  const FareBreakdown({
    required this.totalFareCents,
    required this.baseFareCents,
    required this.distanceChargeCents,
    required this.timeChargeCents,
    required this.surgeMultiplier,
    required this.bookingFeeCents,
  });

  final int totalFareCents;
  final int baseFareCents;
  final int distanceChargeCents;
  final int timeChargeCents;
  final double surgeMultiplier;
  final int bookingFeeCents;

  factory FareBreakdown.fromJson(Map<String, dynamic> j) => FareBreakdown(
        totalFareCents: _int(j['totalFareCents']),
        baseFareCents: _int(j['baseFareCents']),
        distanceChargeCents: _int(j['distanceChargeCents']),
        timeChargeCents: _int(j['timeChargeCents']),
        surgeMultiplier: _double(j['surgeMultiplier'], 1),
        bookingFeeCents: _int(j['bookingFeeCents']),
      );
}

class FareQuote {
  const FareQuote({
    required this.quoteId,
    required this.category,
    required this.fare,
    required this.distanceMetres,
    required this.durationSeconds,
    required this.polyline,
    required this.isEstimate,
    required this.expiresAt,
  });

  final String quoteId;
  final VehicleCategory category;
  final FareBreakdown fare;
  final int distanceMetres;
  final int durationSeconds;
  final String polyline;

  /// True when the server fell back to a straight-line estimate because
  /// routing was unavailable. The UI must say "approximate" rather than
  /// presenting it as a firm price.
  final bool isEstimate;

  final DateTime expiresAt;

  int get totalFareCents => fare.totalFareCents;
  int get etaSeconds => durationSeconds;

  bool get isExpired => DateTime.now().isAfter(expiresAt);

  factory FareQuote.fromJson(Map<String, dynamic> j) => FareQuote(
        quoteId: j['quoteId']?.toString() ?? '',
        category: VehicleCategory.fromWire(j['category']?.toString()),
        fare: FareBreakdown.fromJson(
            (j['fare'] as Map?)?.cast<String, dynamic>() ?? const {}),
        distanceMetres: _int(j['distanceMetres']),
        durationSeconds: _int(j['durationSeconds']),
        polyline: j['polyline']?.toString() ?? '',
        isEstimate: j['isEstimate'] == true,
        expiresAt: DateTime.tryParse(j['expiresAt']?.toString() ?? '') ??
            DateTime.now().add(const Duration(minutes: 3)),
      );
}

// =====================================================================
// Ride
// =====================================================================

enum RideStatus {
  requested, searching, accepted, arrived, inProgress,
  completed, cancelled, expired, failed;

  static RideStatus fromWire(String? v) {
    switch (v) {
      case 'requested': return RideStatus.requested;
      case 'searching': return RideStatus.searching;
      case 'accepted': return RideStatus.accepted;
      case 'arrived': return RideStatus.arrived;
      case 'in_progress': return RideStatus.inProgress;
      case 'completed': return RideStatus.completed;
      case 'expired': return RideStatus.expired;
      case 'failed': return RideStatus.failed;
      default:
        return v != null && v.startsWith('cancelled')
            ? RideStatus.cancelled
            : RideStatus.requested;
    }
  }

  /// Whether the trip is over, one way or another.
  bool get isTerminal => const [
        RideStatus.completed, RideStatus.cancelled,
        RideStatus.expired, RideStatus.failed,
      ].contains(this);

  String get i18nKey => 'status.$name';
}

class DriverProfile {
  const DriverProfile({
    required this.name, required this.rating,
    required this.trips, required this.phoneMasked,
  });
  final String name;
  final double rating;
  final int trips;
  final String phoneMasked;

  factory DriverProfile.fromJson(Map<String, dynamic> j) => DriverProfile(
        name: j['name']?.toString() ?? '',
        rating: _double(j['rating'], 5),
        trips: _int(j['trips']),
        phoneMasked: j['phoneMasked']?.toString() ?? '',
      );
}

class VehicleInfo {
  const VehicleInfo({
    required this.plate, required this.make,
    required this.model, required this.colour, required this.category,
  });
  final String plate;
  final String make;
  final String model;
  final String colour;
  final VehicleCategory category;

  factory VehicleInfo.fromJson(Map<String, dynamic> j) => VehicleInfo(
        plate: j['plate']?.toString() ?? '',
        make: j['make']?.toString() ?? '',
        model: j['model']?.toString() ?? '',
        colour: j['colour']?.toString() ?? '',
        category: VehicleCategory.fromWire(j['category']?.toString()),
      );
}

class Ride {
  const Ride({
    required this.id,
    required this.reference,
    required this.status,
    required this.category,
    required this.quotedFareCents,
    this.finalFareCents,
    required this.paymentMethod,
    required this.isPaid,
    this.driver,
    this.vehicle,
    this.etaSeconds,
  });

  final String id;
  final String reference;
  final RideStatus status;
  final VehicleCategory category;
  final int quotedFareCents;
  final int? finalFareCents;
  final String paymentMethod;
  final bool isPaid;
  final DriverProfile? driver;
  final VehicleInfo? vehicle;
  final int? etaSeconds;

  int get payableCents => finalFareCents ?? quotedFareCents;

  factory Ride.fromJson(Map<String, dynamic> j) => Ride(
        id: (j['rideId'] ?? j['id'])?.toString() ?? '',
        reference: j['reference']?.toString() ?? '',
        status: RideStatus.fromWire(j['status']?.toString()),
        category: VehicleCategory.fromWire(
            (j['category'] ?? j['requestedCategory'])?.toString()),
        quotedFareCents: _int(j['quotedFareCents']),
        finalFareCents:
            j['finalFareCents'] == null ? null : _int(j['finalFareCents']),
        paymentMethod: j['paymentMethod']?.toString() ?? 'cash',
        isPaid: j['isPaid'] == true,
        driver: j['driver'] == null
            ? null
            : DriverProfile.fromJson(
                (j['driver'] as Map).cast<String, dynamic>()),
        vehicle: j['vehicle'] == null
            ? null
            : VehicleInfo.fromJson(
                (j['vehicle'] as Map).cast<String, dynamic>()),
        etaSeconds: j['etaSeconds'] == null ? null : _int(j['etaSeconds']),
      );

  Ride copyWith({RideStatus? status, DriverProfile? driver,
      VehicleInfo? vehicle, int? etaSeconds, int? finalFareCents, bool? isPaid}) =>
      Ride(
        id: id, reference: reference,
        status: status ?? this.status,
        category: category,
        quotedFareCents: quotedFareCents,
        finalFareCents: finalFareCents ?? this.finalFareCents,
        paymentMethod: paymentMethod,
        isPaid: isPaid ?? this.isPaid,
        driver: driver ?? this.driver,
        vehicle: vehicle ?? this.vehicle,
        etaSeconds: etaSeconds ?? this.etaSeconds,
      );
}

// =====================================================================
// Driver-side offer
// =====================================================================

class RideOffer {
  const RideOffer({
    required this.rideId,
    required this.offerToken,
    required this.expiresAt,
    required this.ttlSeconds,
    required this.pickupAddress,
    required this.dropoffAddress,
    required this.distanceToPickupM,
    required this.etaToPickupSeconds,
    required this.tripDistanceM,
    required this.fareCents,
    required this.driverEarningsCents,
    required this.surgeMultiplier,
    required this.riderRating,
    required this.paymentMethod,
  });

  final String rideId;

  /// Short-lived HMAC issued with the offer. Returned on accept so the server
  /// can reject a driver claiming a ride they were never offered.
  final String offerToken;

  /// Absolute server expiry. The countdown is derived from this rather than a
  /// local 15-second tick, so a backgrounded app shows the truth on resume.
  final DateTime expiresAt;

  final int ttlSeconds;
  final String pickupAddress;
  final String dropoffAddress;
  final int distanceToPickupM;
  final int etaToPickupSeconds;
  final int tripDistanceM;
  final int fareCents;

  /// Take-home after commission. Drivers look at this first; showing gross
  /// and revealing the commission later is how a fleet is lost.
  final int driverEarningsCents;

  final double surgeMultiplier;
  final double riderRating;
  final String paymentMethod;

  factory RideOffer.fromJson(Map<String, dynamic> j) => RideOffer(
        rideId: j['rideId']?.toString() ?? '',
        offerToken: j['offerToken']?.toString() ?? '',
        expiresAt: DateTime.tryParse(j['expiresAt']?.toString() ?? '') ??
            DateTime.now().add(const Duration(seconds: 15)),
        ttlSeconds: _int(j['ttlSeconds'], 15),
        pickupAddress: j['pickupAddress']?.toString() ?? '',
        dropoffAddress: j['dropoffAddress']?.toString() ?? '',
        distanceToPickupM: _int(j['distanceToPickupM']),
        etaToPickupSeconds: _int(j['etaToPickupSeconds']),
        tripDistanceM: _int(j['tripDistanceM']),
        fareCents: _int(j['fareCents']),
        driverEarningsCents: _int(j['driverEarningsCents']),
        surgeMultiplier: _double(j['surgeMultiplier'], 1),
        riderRating: _double(j['riderRating'], 5),
        paymentMethod: j['paymentMethod']?.toString() ?? 'cash',
      );
}

// =====================================================================
// Places
// =====================================================================

class PlaceSuggestion {
  const PlaceSuggestion({
    required this.placeId, required this.primary, required this.secondary,
  });
  final String placeId;
  final String primary;
  final String secondary;

  factory PlaceSuggestion.fromJson(Map<String, dynamic> j) => PlaceSuggestion(
        placeId: j['placeId']?.toString() ?? '',
        primary: j['primary']?.toString() ?? '',
        secondary: j['secondary']?.toString() ?? '',
      );
}

class AppUser {
  const AppUser({
    required this.id, required this.phone, required this.fullName,
    required this.language, required this.isDriver,
  });
  final String id;
  final String phone;
  final String fullName;
  final String language;
  final bool isDriver;

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: j['id']?.toString() ?? '',
        phone: j['phone']?.toString() ?? '',
        fullName: j['fullName']?.toString() ?? '',
        language: j['language']?.toString() ?? 'sw',
        isDriver: j['isDriver'] == true,
      );
}
