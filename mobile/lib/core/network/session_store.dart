/// Token storage.
///
/// Access and refresh tokens go in the platform keystore (Keychain on iOS,
/// EncryptedSharedPreferences on Android) rather than plain preferences. A
/// refresh token is valid for sixty days and is enough to impersonate the
/// account, so it must not sit in a file that any backup tool can read off a
/// rooted handset — and rooted handsets are common in this market.
///
/// The device id is deliberately *not* secret. The server binds refresh
/// tokens to it, so a token lifted from one phone is useless on another
/// without also cloning the id.

import 'dart:convert';
import 'dart:math';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SessionStore {
  SessionStore(this._prefs);

  final SharedPreferences _prefs;
  static const _secure = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _kAccess = 'kwema_access';
  static const _kRefresh = 'kwema_refresh';
  static const _kDevice = 'kwema_device_id';
  static const _kUserId = 'kwema_user_id';
  static const _kUserJson = 'kwema_user_json';

  Future<String?> accessToken() => _secure.read(key: _kAccess);
  Future<String?> refreshToken() => _secure.read(key: _kRefresh);

  Future<void> save({
    required String accessToken,
    required String refreshToken,
    String? userId,
  }) async {
    await _secure.write(key: _kAccess, value: accessToken);
    await _secure.write(key: _kRefresh, value: refreshToken);
    if (userId != null) await _prefs.setString(_kUserId, userId);
  }

  Future<void> clear() async {
    await _secure.delete(key: _kAccess);
    await _secure.delete(key: _kRefresh);
    await _prefs.remove(_kUserId);
    await _prefs.remove(_kUserJson);
  }

  Future<bool> get hasSession async => (await refreshToken()) != null;

  /// Last known profile, so the app can open offline showing the person's own
  /// name instead of a blank header or a forced re-login.
  Future<void> cacheUser(Map<String, dynamic> user) =>
      _prefs.setString(_kUserJson, jsonEncode(user));

  Map<String, dynamic>? cachedUser() {
    final raw = _prefs.getString(_kUserJson);
    if (raw == null) return null;
    try {
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  String? get userId => _prefs.getString(_kUserId);

  /// Stable per-installation id. Generated once and kept; reinstalling the
  /// app produces a new one, which correctly invalidates old refresh tokens.
  Future<String> deviceId() async {
    final existing = _prefs.getString(_kDevice);
    if (existing != null) return existing;
    final rnd = Random.secure();
    final id = List.generate(16, (_) => rnd.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    await _prefs.setString(_kDevice, id);
    return id;
  }
}
