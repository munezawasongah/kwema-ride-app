/// Realtime client.
///
/// Mirrors the gateway's contract: `session:ready` on connect,
/// `ride:status_change` / `ride:driver_moved` / `ride:request` inbound, and
/// an application heartbeat outbound every 20 seconds.
///
/// Why an app-level heartbeat on top of Socket.IO's own ping: on a Tanzanian
/// mobile network a socket routinely stays "open" while packets are being
/// dropped — a half-open TCP connection after a cell handover looks alive for
/// minutes. The server reaps sockets that go quiet, and this is what keeps a
/// working connection from being reaped.
///
/// Clock skew: the heartbeat ack carries server time. Handsets in the field
/// are often minutes off, which would corrupt trip timestamps and make the
/// driver's offer countdown wrong, so the offset is tracked and applied.

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_client.dart';
import 'session_store.dart';

typedef JsonMap = Map<String, dynamic>;

class SocketClient {
  SocketClient(this._session);

  final SessionStore _session;
  io.Socket? _socket;
  Timer? _heartbeat;
  Duration _clockSkew = Duration.zero;

  final _status = StreamController<JsonMap>.broadcast();
  final _driverMoved = StreamController<JsonMap>.broadcast();
  final _offers = StreamController<JsonMap>.broadcast();
  final _payments = StreamController<JsonMap>.broadcast();
  final _connection = StreamController<bool>.broadcast();

  Stream<JsonMap> get rideStatus => _status.stream;
  Stream<JsonMap> get driverMoved => _driverMoved.stream;
  Stream<JsonMap> get offers => _offers.stream;
  Stream<JsonMap> get payments => _payments.stream;
  Stream<bool> get connection => _connection.stream;

  bool get isConnected => _socket?.connected ?? false;

  /// Server time, corrected for handset clock drift.
  DateTime get serverNow => DateTime.now().add(_clockSkew);

  Future<void> connect() async {
    if (_socket != null) return;
    final token = await _session.accessToken();
    if (token == null) return;

    final socket = io.io(
      '$kApiBaseUrl/rt',
      io.OptionBuilder()
          // WebSocket first, polling as fallback: some mobile proxies here
          // still break the upgrade, and polling keeps those users working
          // rather than showing a dead map.
          .setTransports(['websocket', 'polling'])
          .setAuth({'token': token})
          .enableReconnection()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(8000)
          .setReconnectionAttempts(999999)
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      _connection.add(true);
      _startHeartbeat();
    });
    socket.onDisconnect((_) {
      _connection.add(false);
      _heartbeat?.cancel();
    });
    socket.onConnectError((e) => debugPrint('socket connect error: $e'));

    socket.on('session:ready', (data) {
      if (data is Map) {
        final serverTime = data['serverTime'];
        if (serverTime is int) {
          _clockSkew = DateTime.fromMillisecondsSinceEpoch(serverTime)
              .difference(DateTime.now());
        }
        // Active rides arrive here, which is what makes a reconnect seamless:
        // the client does not re-subscribe, it just re-renders.
        _status.add(data.cast<String, dynamic>());
      }
    });

    socket.on('ride:status_change', (d) => _emit(_status, d));
    socket.on('ride:driver_moved', (d) => _emit(_driverMoved, d));
    socket.on('ride:request', (d) => _emit(_offers, d));
    socket.on('ride:offer_closed', (d) => _emit(_offers, d));
    socket.on('ride:fare_ready', (d) => _emit(_status, d));
    socket.on('payment:status', (d) => _emit(_payments, d));

    socket.connect();
  }

  void _emit(StreamController<JsonMap> c, dynamic data) {
    if (data is Map) c.add(data.cast<String, dynamic>());
  }

  void _startHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      _socket?.emitWithAck('hb', {'t': DateTime.now().millisecondsSinceEpoch},
          ack: (dynamic reply) {
        if (reply is Map && reply['t'] is int) {
          _clockSkew = DateTime.fromMillisecondsSinceEpoch(reply['t'] as int)
              .difference(DateTime.now());
        }
      });
    });
  }

  /// Emits and waits for the server ack, or null on timeout. The location
  /// queue relies on this: a fix is only deleted from the device buffer once
  /// the server has acknowledged its sequence number.
  Future<dynamic> emitWithAck(
    String event,
    dynamic payload, {
    Duration timeout = const Duration(seconds: 8),
  }) {
    final socket = _socket;
    if (socket == null || !socket.connected) return Future.value(null);

    final completer = Completer<dynamic>();
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) completer.complete(null);
    });
    socket.emitWithAck(event, payload, ack: (dynamic reply) {
      timer.cancel();
      if (!completer.isCompleted) completer.complete(reply);
    });
    return completer.future;
  }

  void emit(String event, dynamic payload) => _socket?.emit(event, payload);

  void reportDiagnostic(String kind, String detail) =>
      debugPrint('[$kind] $detail');

  Future<void> disconnect() async {
    _heartbeat?.cancel();
    _socket?.dispose();
    _socket = null;
    _connection.add(false);
  }

  void dispose() {
    _heartbeat?.cancel();
    _socket?.dispose();
    _status.close();
    _driverMoved.close();
    _offers.close();
    _payments.close();
    _connection.close();
  }
}
