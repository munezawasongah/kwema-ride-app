/// HTTP client.
///
/// Two things here are shaped by the network rather than by taste:
///
///   Retries. A request that fails on a connection error is retried with
///   backoff, because a 3G handover produces exactly that and a single
///   failure should not surface as an error to someone standing at a
///   roadside. Requests that fail with a 4xx are never retried — the server
///   has answered, and repeating it just wastes their bundle.
///
///   Token refresh. A 401 triggers one refresh attempt and one replay of the
///   original request. Concurrent 401s share a single refresh through
///   `_refreshing`, so ten queued requests do not fire ten refresh calls and
///   invalidate each other's rotated token.

import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'session_store.dart';

/// Overridden in main() with --dart-define=API_BASE_URL=...
const String kApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://kwema-ride-app-production.up.railway.app',
);

/// Why a token refresh did not produce a new access token.
enum RefreshOutcome {
  /// A new access token was issued.
  ok,

  /// The server refused the refresh token. The session is over.
  rejected,

  /// The server could not be reached. The session is still valid.
  unreachable,
}

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.code});
  final String message;
  final int? statusCode;
  final String? code;

  /// True when retrying later might plausibly succeed.
  bool get isTransient =>
      statusCode == null || statusCode! >= 500 || statusCode == 429;

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this._session) {
    _dio = Dio(BaseOptions(
      baseUrl: '$kApiBaseUrl/api',
      // Generous: a cold Railway container plus a slow handover can take
      // this long, and a premature timeout looks like a failure to the user.
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 25),
      sendTimeout: const Duration(seconds: 20),
      headers: {'Content-Type': 'application/json'},
      // We handle status codes ourselves so errors carry server messages.
      validateStatus: (_) => true,
    ));
  }

  late final Dio _dio;
  final SessionStore _session;
  Future<RefreshOutcome>? _refreshing;

  /// Called when refresh fails and the user must sign in again.
  VoidCallback? onSessionExpired;

  // -----------------------------------------------------------------

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _send('GET', path, query: query);

  Future<dynamic> post(String path, [Map<String, dynamic>? body]) =>
      _send('POST', path, body: body);

  Future<dynamic> patch(String path, [Map<String, dynamic>? body]) =>
      _send('PATCH', path, body: body);

  // -----------------------------------------------------------------

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, dynamic>? query,
    int attempt = 0,
    bool didRefresh = false,
  }) async {
    final token = await _session.accessToken();

    late Response<dynamic> response;
    try {
      response = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(
          method: method,
          headers: token == null ? null : {'Authorization': 'Bearer $token'},
        ),
      );
    } on DioException catch (e) {
      // Connection-level failure: worth retrying, unlike a server answer.
      final retryable = e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.connectionError;
      if (retryable && attempt < 2) {
        await Future<void>.delayed(Duration(milliseconds: 600 * (attempt + 1)));
        return _send(method, path,
            body: body, query: query, attempt: attempt + 1, didRefresh: didRefresh);
      }
      throw ApiException('network_unreachable');
    }

    final status = response.statusCode ?? 0;

    if (status == 401 && !didRefresh) {
      final outcome = await _refreshOnce();

      if (outcome == RefreshOutcome.ok) {
        return _send(method, path, body: body, query: query, didRefresh: true);
      }

      if (outcome == RefreshOutcome.unreachable) {
        // Keep the session. The caller sees a network error, which is the
        // truth, and the next attempt on a better connection will succeed.
        throw ApiException('network_unreachable');
      }

      onSessionExpired?.call();
      throw ApiException('session_expired', statusCode: 401);
    }

    if (status >= 200 && status < 300) return response.data;

    final data = response.data;
    final message = data is Map && data['message'] != null
        ? (data['message'] is List
            ? (data['message'] as List).join(', ')
            : data['message'].toString())
        : 'request_failed';
    throw ApiException(message, statusCode: status);
  }

  /// Single-flight refresh: concurrent 401s wait on the same future rather
  /// than each rotating the refresh token and invalidating the others.
  Future<RefreshOutcome> _refreshOnce() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  /// Refreshes the access token.
  ///
  /// Returns three distinct outcomes rather than a boolean, because
  /// collapsing them is what made the app demand a new SMS code every time
  /// it opened on a weak signal: an unreachable server was treated as a
  /// rejected credential, and the session was wiped.
  ///
  /// Only [RefreshOutcome.rejected] — the server actually refusing the token
  /// — ends a session.
  Future<RefreshOutcome> _doRefresh() async {
    final refresh = await _session.refreshToken();
    if (refresh == null) return RefreshOutcome.rejected;

    try {
      final res = await _dio.post<dynamic>('/auth/refresh', data: {
        'refreshToken': refresh,
        'deviceId': await _session.deviceId(),
      });

      final status = res.statusCode ?? 0;
      if (status == 200 || status == 201) {
        final data = (res.data as Map).cast<String, dynamic>();
        await _session.save(
          accessToken: data['accessToken'].toString(),
          refreshToken: data['refreshToken'].toString(),
        );
        return RefreshOutcome.ok;
      }

      // 401 or 403 means the token is genuinely no longer valid. A 5xx is the
      // server having a bad time, which is not the user's problem to solve by
      // signing in again.
      return (status == 401 || status == 403)
          ? RefreshOutcome.rejected
          : RefreshOutcome.unreachable;
    } on DioException catch (e) {
      final networkish = e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.sendTimeout ||
          e.type == DioExceptionType.connectionError;
      return networkish ? RefreshOutcome.unreachable : RefreshOutcome.rejected;
    } catch (_) {
      return RefreshOutcome.unreachable;
    }
  }
}

// ---------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------

/// Overridden in main() once SharedPreferences has loaded, so the rest of
/// the tree can read it synchronously.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('override in main()'),
);

final sessionStoreProvider = Provider<SessionStore>(
  (ref) => SessionStore(ref.watch(sharedPreferencesProvider)),
);

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(ref.watch(sessionStoreProvider)),
);
