/// Offline-first location pipeline for the driver app.
///
/// The problem this solves: a driver crossing the Ubungo interchange or
/// running along a stretch of the Morogoro road can lose data for two or
/// three minutes at a time. If the app drops those fixes, the trip trace has
/// holes, the distance-based fare under-charges, and disputes follow.
///
/// Design
///  * Every fix goes to a local SQLite buffer first, then to the socket.
///    The buffer is the source of truth; the socket is best-effort.
///  * Rows are deleted only after the server acknowledges the sequence
///    number. An ack we never receive means the fix is re-sent, and the
///    server deduplicates on (driverId, seq).
///  * Cadence adapts. A stationary driver waiting at Mlimani City does not
///    need a 4-second ping; that is battery and bundle spent for nothing.
///  * The buffer is bounded. On a long outage we thin the oldest fixes
///    rather than growing without limit — a 10-second trace of a road
///    travelled 40 minutes ago is worth as much as a 4-second one.

import 'dart:async';
import 'dart:collection';
import 'dart:math' as math;

import 'package:geolocator/geolocator.dart';
import 'package:sqflite/sqflite.dart';

import '../network/socket_client.dart';

class LocationFix {
  LocationFix({
    required this.seq,
    required this.lat,
    required this.lng,
    required this.headingDeg,
    required this.speedKph,
    required this.accuracyM,
    required this.recordedAt,
    this.rideId,
  });

  final int seq;
  final double lat;
  final double lng;
  final int headingDeg;
  final int speedKph;
  final int accuracyM;
  final DateTime recordedAt;
  final String? rideId;

  /// Wire form matching the gateway's `LocationPing`. Coordinates are sent as
  /// integers scaled by 1e6 (~0.1 m resolution) — shorter on the wire than
  /// full-precision doubles, and precise enough for a road.
  Map<String, dynamic> toWire({bool backfilled = false}) => {
        'la': (lat * 1e6).round(),
        'ln': (lng * 1e6).round(),
        'h': headingDeg,
        's': speedKph,
        'a': accuracyM,
        't': recordedAt.millisecondsSinceEpoch,
        'q': seq,
        if (rideId != null) 'r': rideId,
        if (backfilled) 'b': true,
      };

  Map<String, Object?> toRow() => {
        'seq': seq,
        'lat': lat,
        'lng': lng,
        'heading': headingDeg,
        'speed': speedKph,
        'accuracy': accuracyM,
        'recorded_at': recordedAt.millisecondsSinceEpoch,
        'ride_id': rideId,
      };

  static LocationFix fromRow(Map<String, Object?> row) => LocationFix(
        seq: row['seq'] as int,
        lat: row['lat'] as double,
        lng: row['lng'] as double,
        headingDeg: row['heading'] as int,
        speedKph: row['speed'] as int,
        accuracyM: row['accuracy'] as int,
        recordedAt:
            DateTime.fromMillisecondsSinceEpoch(row['recorded_at'] as int),
        rideId: row['ride_id'] as String?,
      );
}

class OfflineLocationQueue {
  OfflineLocationQueue(this._socket, this._db);

  final SocketClient _socket;
  final Database _db;

  StreamSubscription<Position>? _positionSub;
  Timer? _flushTimer;

  int _seq = 0;
  Position? _lastSent;
  String? _activeRideId;
  bool _flushing = false;

  /// In-memory mirror of the head of the buffer, so a flush does not hit
  /// SQLite for the common case of one or two pending fixes.
  final Queue<LocationFix> _hot = Queue();

  // --- Tuning ---------------------------------------------------------
  static const int _maxBufferedFixes = 2000; // ~2h at the slow cadence
  static const Duration _flushInterval = Duration(seconds: 4);
  static const int _batchSize = 50;

  /// Distance filters by movement state. A driver crawling in Kariakoo
  /// traffic still needs fine granularity; one on the highway does not.
  static const int _stationaryFilterM = 30;
  static const int _movingFilterM = 10;

  // ====================================================================
  // Lifecycle
  // ====================================================================

  static Future<Database> openBuffer() async {
    final path = '${await getDatabasesPath()}/location_buffer.db';
    return openDatabase(
      path,
      version: 1,
      onCreate: (db, _) async {
        await db.execute('''
          CREATE TABLE fixes (
            seq         INTEGER PRIMARY KEY,
            lat         REAL    NOT NULL,
            lng         REAL    NOT NULL,
            heading     INTEGER NOT NULL,
            speed       INTEGER NOT NULL,
            accuracy    INTEGER NOT NULL,
            recorded_at INTEGER NOT NULL,
            ride_id     TEXT
          )
        ''');
        await db.execute('CREATE INDEX fixes_time ON fixes (recorded_at)');
        await db.execute('''
          CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)
        ''');
      },
    );
  }

  Future<void> start({String? rideId}) async {
    _activeRideId = rideId;

    // Restore the sequence counter so numbers keep climbing across restarts;
    // a reset would make the server treat live fixes as stale replays.
    final row = await _db.query('meta', where: 'k = ?', whereArgs: ['seq']);
    _seq = row.isEmpty ? 0 : int.parse(row.first['v'] as String);

    await _ensurePermission();

    _positionSub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: _movingFilterM,
        intervalDuration: const Duration(seconds: 4),
        // Keeps GPS alive when the driver switches to WhatsApp or navigation.
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'Kwema Ride',
          notificationText: 'Uko kazini', // "You are online"
          enableWakeLock: true,
          setOngoing: true,
        ),
      ),
    ).listen(_onPosition, onError: (Object e) {
      // A GPS error must never kill the stream; the driver would silently
      // stop receiving offers with no visible cause.
      _socket.reportDiagnostic('location_stream_error', e.toString());
    });

    _flushTimer = Timer.periodic(_flushInterval, (_) => flush());

    // Drain whatever survived the last session before sending anything new.
    unawaited(flush(includeBackfill: true));
  }

  Future<void> stop() async {
    await _positionSub?.cancel();
    _flushTimer?.cancel();
    await flush(includeBackfill: true); // last-gasp drain
  }

  void setActiveRide(String? rideId) => _activeRideId = rideId;

  // ====================================================================
  // Capture
  // ====================================================================

  Future<void> _onPosition(Position position) async {
    if (!_shouldRecord(position)) return;

    _seq += 1;
    final fix = LocationFix(
      seq: _seq,
      lat: position.latitude,
      lng: position.longitude,
      headingDeg: position.heading.isNaN ? 0 : position.heading.round() % 360,
      speedKph: position.speed.isNaN ? 0 : (position.speed * 3.6).round(),
      accuracyM: position.accuracy.round(),
      recordedAt: position.timestamp,
      rideId: _activeRideId,
    );

    _hot.add(fix);
    _lastSent = position;

    await _db.insert('fixes', fix.toRow(),
        conflictAlgorithm: ConflictAlgorithm.replace);
    await _db.insert('meta', {'k': 'seq', 'v': '$_seq'},
        conflictAlgorithm: ConflictAlgorithm.replace);

    await _trimBuffer();

    // Opportunistic send. If it fails, the periodic flush picks it up.
    if (_socket.isConnected) unawaited(flush());
  }

  /// Suppresses fixes that carry no information.
  bool _shouldRecord(Position position) {
    // Junk fix — an accuracy circle wider than a city block would drag the
    // rider's map marker across the road.
    if (position.accuracy > 100) return false;

    final previous = _lastSent;
    if (previous == null) return true;

    final metres = Geolocator.distanceBetween(
      previous.latitude,
      previous.longitude,
      position.latitude,
      position.longitude,
    );

    final isStationary = (position.speed.isNaN ? 0 : position.speed) < 1.0;
    final threshold = isStationary ? _stationaryFilterM : _movingFilterM;

    // Always send at least one fix a minute even when parked, so the server
    // does not reap the driver from the dispatch pool as stale.
    final elapsed = position.timestamp.difference(previous.timestamp);
    if (elapsed > const Duration(seconds: 45)) return true;

    return metres >= threshold;
  }

  /// Bounded buffer: on a long outage, thin the oldest half by dropping
  /// every other fix rather than losing the route entirely.
  Future<void> _trimBuffer() async {
    final countResult =
        await _db.rawQuery('SELECT COUNT(*) AS c FROM fixes');
    final count = countResult.first['c'] as int;
    if (count <= _maxBufferedFixes) return;

    await _db.rawDelete('''
      DELETE FROM fixes
       WHERE seq IN (
         SELECT seq FROM fixes
          ORDER BY recorded_at ASC
          LIMIT ?
       )
       AND seq % 2 = 0
    ''', [count ~/ 2]);
  }

  // ====================================================================
  // Flush
  // ====================================================================

  /// Sends buffered fixes, oldest first, deleting each only after its ack.
  /// Re-entrant calls are ignored so a burst of positions cannot start
  /// several concurrent drains fighting over the same rows.
  Future<void> flush({bool includeBackfill = false}) async {
    if (_flushing || !_socket.isConnected) return;
    _flushing = true;

    try {
      while (true) {
        final rows = await _db.query('fixes',
            orderBy: 'recorded_at ASC', limit: _batchSize);
        if (rows.isEmpty) break;

        final fixes = rows.map(LocationFix.fromRow).toList();
        final sentSeqs = <int>[];

        for (final fix in fixes) {
          // A fix older than the flush interval is by definition a replay
          // from an outage; flagging it lets the server persist it for the
          // trip trace without treating it as the driver's live position.
          final isBackfill = DateTime.now().difference(fix.recordedAt) >
              const Duration(seconds: 15);

          final ack = await _socket.emitWithAck(
            'driver:location_update',
            fix.toWire(backfilled: isBackfill),
            timeout: const Duration(seconds: 8),
          );

          // No ack means the link died mid-batch. Stop and keep the rest
          // buffered; retrying the whole batch is cheaper than losing it.
          if (ack == null) break;

          // The server rejected this fix on its merits (bad accuracy, bad
          // coordinates). Retrying will never help, so drop it.
          sentSeqs.add(fix.seq);
        }

        if (sentSeqs.isEmpty) break;

        await _db.delete(
          'fixes',
          where: 'seq IN (${List.filled(sentSeqs.length, '?').join(',')})',
          whereArgs: sentSeqs,
        );
        _hot.removeWhere((f) => sentSeqs.contains(f.seq));

        if (sentSeqs.length < fixes.length) break; // link broke mid-batch
      }
    } finally {
      _flushing = false;
    }
  }

  // ====================================================================
  // Permissions
  // ====================================================================

  Future<void> _ensurePermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const LocationServiceDisabledException();
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      throw Exception('location_permission_denied');
    }
  }

  /// Straight-line distance between two fixes, used by the local trip-distance
  /// estimator that keeps the driver's meter moving while offline.
  static double haversineMetres(LocationFix a, LocationFix b) {
    const earthRadiusM = 6371000.0;
    final dLat = _rad(b.lat - a.lat);
    final dLng = _rad(b.lng - a.lng);
    final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(_rad(a.lat)) *
            math.cos(_rad(b.lat)) *
            math.sin(dLng / 2) *
            math.sin(dLng / 2);
    return earthRadiusM * 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h));
  }

  static double _rad(double deg) => deg * math.pi / 180.0;
}
