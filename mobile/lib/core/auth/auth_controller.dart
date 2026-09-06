/// Authentication: phone + OTP, shared by both apps.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/models.dart';
import '../network/api_client.dart';
import '../network/session_store.dart';

enum AuthStage { checking, phoneEntry, codeEntry, authenticated }

class AuthState {
  const AuthState({
    required this.stage,
    this.phone,
    this.user,
    this.error,
    this.busy = false,
    this.resendAfter = 0,
  });

  final AuthStage stage;
  final String? phone;
  final AppUser? user;
  final String? error;
  final bool busy;

  /// Seconds remaining on the resend cooldown, 0 when it can be resent.
  final int resendAfter;

  AuthState copyWith({
    AuthStage? stage, String? phone, AppUser? user,
    String? error, bool? busy, int? resendAfter,
  }) => AuthState(
        stage: stage ?? this.stage,
        phone: phone ?? this.phone,
        user: user ?? this.user,
        error: error,
        busy: busy ?? this.busy,
        resendAfter: resendAfter ?? this.resendAfter,
      );
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._api, this._session)
      : super(const AuthState(stage: AuthStage.checking)) {
    _restore();
  }

  final ApiClient _api;
  final SessionStore _session;

  Future<void> _restore() async {
    if (!await _session.hasSession) {
      state = const AuthState(stage: AuthStage.phoneEntry);
      return;
    }
    try {
      final me = await _api.get('/users/me');
      state = AuthState(
        stage: AuthStage.authenticated,
        user: AppUser.fromJson((me as Map).cast<String, dynamic>()),
      );
    } catch (_) {
      // Refresh failed or the account is gone; start clean rather than
      // leaving the app in a half-signed-in state.
      await _session.clear();
      state = const AuthState(stage: AuthStage.phoneEntry);
    }
  }

  /// Requests a code. The server returns sent:false while the 60-second
  /// resend cooldown is running — advancing to the code screen anyway would
  /// prompt for an SMS that was never sent.
  Future<void> requestCode(String phone) async {
    if (!RegExp(r'^\+255[0-9]{9}$').hasMatch(phone)) {
      state = state.copyWith(error: 'error.phone_format');
      return;
    }
    state = state.copyWith(busy: true, error: null);
    try {
      final res = await _api.post('/auth/otp/request', {'phone': phone});
      final map = (res as Map).cast<String, dynamic>();

      if (map['sent'] == false) {
        state = state.copyWith(
          busy: false,
          phone: phone,
          error: 'error.otp_cooldown',
          resendAfter: (map['retryAfter'] as num?)?.toInt() ?? 60,
        );
        return;
      }
      state = state.copyWith(
        stage: AuthStage.codeEntry, phone: phone, busy: false, resendAfter: 60,
      );
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, error: e.message);
    }
  }

  Future<void> verifyCode(String code) async {
    final phone = state.phone;
    if (phone == null) return;

    state = state.copyWith(busy: true, error: null);
    try {
      final res = await _api.post('/auth/otp/verify', {
        'phone': phone,
        'code': code,
        'deviceId': await _session.deviceId(),
      });
      final map = (res as Map).cast<String, dynamic>();
      final user = AppUser.fromJson(
          (map['user'] as Map).cast<String, dynamic>());

      await _session.save(
        accessToken: map['accessToken'].toString(),
        refreshToken: map['refreshToken'].toString(),
        userId: user.id,
      );
      state = AuthState(stage: AuthStage.authenticated, user: user, phone: phone);
    } on ApiException catch (e) {
      state = state.copyWith(
        busy: false,
        error: e.statusCode == 401 ? 'error.otp_invalid' : e.message,
      );
    }
  }

  void backToPhone() =>
      state = AuthState(stage: AuthStage.phoneEntry, phone: state.phone);

  Future<void> signOut() async {
    try {
      await _api.post('/auth/logout', {});
    } catch (_) {
      // A failed logout call must not trap the user in a signed-in state.
    }
    await _session.clear();
    state = const AuthState(stage: AuthStage.phoneEntry);
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(
    ref.watch(apiClientProvider),
    ref.watch(sessionStoreProvider),
  );
});
