/// Authentication: phone + OTP, shared by both apps.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/models.dart';
import '../network/api_client.dart';
import '../network/session_store.dart';

enum AuthStage { checking, phoneEntry, codeEntry, nameEntry, authenticated }

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
    // Guarded: a keystore read that throws here would leave the app stuck on
    // the loading state forever, because nothing above catches it.
    bool signedIn;
    try {
      signedIn = await _session.hasSession;
    } catch (_) {
      signedIn = false;
    }

    if (!signedIn) {
      state = const AuthState(stage: AuthStage.phoneEntry);
      return;
    }
    try {
      final me = await _api.get('/users/me');
      final user = AppUser.fromJson((me as Map).cast<String, dynamic>());
      await _session.cacheUser(me.cast<String, dynamic>());
      state = AuthState(
        stage: user.fullName.trim().isEmpty
            ? AuthStage.nameEntry
            : AuthStage.authenticated,
        user: user,
      );
    } on ApiException catch (e) {
      // Only a rejected credential ends the session. Clearing it on any
      // failure meant a moment of bad signal at launch logged the user out
      // and forced another SMS — the opposite of "verify once".
      if (e.statusCode == 401) {
        await _session.clear();
        state = const AuthState(stage: AuthStage.phoneEntry);
        return;
      }

      // Offline: trust the stored session and carry on with the cached
      // profile. Anything that genuinely needs the server will surface its
      // own error rather than throwing the user back to a login screen.
      final cached = _session.cachedUser();
      state = AuthState(
        stage: AuthStage.authenticated,
        user: cached == null ? null : AppUser.fromJson(cached),
      );
    } catch (_) {
      final cached = _session.cachedUser();
      state = AuthState(
        stage: AuthStage.authenticated,
        user: cached == null ? null : AppUser.fromJson(cached),
      );
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
      await _session.cacheUser((map['user'] as Map).cast<String, dynamic>());

      // A new account has no name until the person gives one, so go to the
      // name step rather than straight in as "Mteja".
      state = AuthState(
        stage: user.fullName.trim().isEmpty
            ? AuthStage.nameEntry
            : AuthStage.authenticated,
        user: user,
        phone: phone,
      );
    } on ApiException catch (e) {
      state = state.copyWith(
        busy: false,
        error: e.statusCode == 401 ? 'error.otp_invalid' : e.message,
      );
    }
  }

  /// Saves the display name for a new account. This is what a driver sees on
  /// an incoming request and what the rider sees on the trip screen, so it is
  /// asked once, at signup, rather than left as a placeholder.
  Future<void> saveName(String name) async {
    final trimmed = name.trim();
    if (trimmed.length < 2) {
      state = state.copyWith(error: 'error.name_too_short');
      return;
    }
    state = state.copyWith(busy: true, error: null);
    try {
      final res = await _api.patch('/users/me', {'fullName': trimmed});
      final user = AppUser.fromJson((res as Map).cast<String, dynamic>());
      await _session.cacheUser(res.cast<String, dynamic>());
      state = AuthState(stage: AuthStage.authenticated, user: user);
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, error: e.message);
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

/// The signed-in user's profile from the server.
///
/// Lives here rather than in a screen file: several widgets need it, and
/// importing a screen to reach a provider creates import cycles.
final profileProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get('/users/me');
  return (res as Map).cast<String, dynamic>();
});

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(
    ref.watch(apiClientProvider),
    ref.watch(sessionStoreProvider),
  );
});
