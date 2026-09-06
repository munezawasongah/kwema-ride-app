/// Kwema Ride — visual identity.
///
/// The palette is built on two locally-rooted colours rather than a default
/// Material scheme:
///
///   Tanzanite  — the blue-violet gemstone mined only in Tanzania, at the
///                foot of Kilimanjaro. Deep, saturated, and unmistakably not
///                the green of Bolt or the black of Uber. Carries structure:
///                navigation, primary actions, headers.
///
///   Marigold   — the warm ochre of Dar's afternoon light and of the
///                bajaji/boda fleet itself. Reserved almost entirely for
///                money: fares, driver earnings, surge. When a driver sees
///                marigold, it is about what they are paid.
///
/// Neutrals are warm-shifted (a trace of red in the greys) rather than the
/// pure #808080 family. Under bright equatorial sun on a cheap LCD, cool
/// greys read as dead blue-grey; warm greys hold their character.
///
/// One typeface, not two. Every extra font file is a download on a metered
/// 3G bundle, so weight and size carry the hierarchy instead of a second
/// family. DM Sans has open apertures that survive a scratched screen, and
/// its tabular figures keep fare columns from jittering as digits change.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

class KwemaColors {
  const KwemaColors._();

  // --- Tanzanite -----------------------------------------------------
  static const tanzanite900 = Color(0xFF131A3D);
  static const tanzanite800 = Color(0xFF1C2557);
  static const tanzanite700 = Color(0xFF26327A);
  static const tanzanite600 = Color(0xFF30409B);
  static const tanzanite500 = Color(0xFF3A4BB8); // primary
  static const tanzanite400 = Color(0xFF6470CE);
  static const tanzanite300 = Color(0xFF8B96DE);
  static const tanzanite100 = Color(0xFFD5D9F5);
  static const tanzanite50 = Color(0xFFEEF0FC);

  // --- Marigold — money, surge, earnings -----------------------------
  static const marigold700 = Color(0xFF8A5B0A);
  static const marigold600 = Color(0xFFB87A12);
  static const marigold500 = Color(0xFFE39B1F);
  static const marigold300 = Color(0xFFF2C673);
  static const marigold50 = Color(0xFFFDF2DE);

  // --- Warm neutrals -------------------------------------------------
  static const ink = Color(0xFF1C1A17);
  static const inkSoft = Color(0xFF433F39);
  static const muted = Color(0xFF6B665E);
  static const hint = Color(0xFF979187);
  static const line = Color(0xFFE4DFD7);
  static const surfaceAlt = Color(0xFFF4F1EB);
  static const canvas = Color(0xFFFAF8F5);
  static const white = Color(0xFFFFFFFF);

  // --- Dark mode surfaces --------------------------------------------
  static const darkCanvas = Color(0xFF12141C);
  static const darkSurface = Color(0xFF1A1D28);
  static const darkSurfaceAlt = Color(0xFF232736);
  static const darkLine = Color(0xFF313648);

  // --- Status --------------------------------------------------------
  static const go = Color(0xFF1E7A4C); // accept, trip active
  static const goSoft = Color(0xFFE3F3EA);
  static const stop = Color(0xFFC0392B); // cancel, decline
  static const stopSoft = Color(0xFFFBEAE8);

  /// Fleet colours for the category selector. Each tier gets its own hue so
  /// a driver or rider recognises the tile by colour before reading it —
  /// meaningful for riders with limited literacy, which is a real share of
  /// this market.
  static const boda = Color(0xFFD9722B);
  static const bajaji = Color(0xFFC9A227);
  static const car = tanzanite500;
  static const xl = Color(0xFF2E7D74);
}

class KwemaTheme {
  const KwemaTheme._();

  static const _radius = 14.0;

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;

    final scheme = ColorScheme(
      brightness: brightness,
      primary: isDark ? KwemaColors.tanzanite400 : KwemaColors.tanzanite500,
      onPrimary: Colors.white,
      primaryContainer:
          isDark ? KwemaColors.tanzanite800 : KwemaColors.tanzanite50,
      onPrimaryContainer:
          isDark ? KwemaColors.tanzanite100 : KwemaColors.tanzanite800,
      secondary: KwemaColors.marigold500,
      onSecondary: KwemaColors.marigold700,
      secondaryContainer:
          isDark ? KwemaColors.marigold700 : KwemaColors.marigold50,
      onSecondaryContainer:
          isDark ? KwemaColors.marigold50 : KwemaColors.marigold700,
      error: KwemaColors.stop,
      onError: Colors.white,
      surface: isDark ? KwemaColors.darkSurface : KwemaColors.white,
      onSurface: isDark ? const Color(0xFFEDEAE5) : KwemaColors.ink,
      surfaceContainerHighest:
          isDark ? KwemaColors.darkSurfaceAlt : KwemaColors.surfaceAlt,
      onSurfaceVariant: isDark ? const Color(0xFFA9A49B) : KwemaColors.muted,
      outline: isDark ? KwemaColors.darkLine : KwemaColors.line,
      outlineVariant: isDark ? KwemaColors.darkLine : KwemaColors.line,
      shadow: Colors.black,
      scrim: Colors.black,
      inverseSurface: isDark ? KwemaColors.white : KwemaColors.ink,
      onInverseSurface: isDark ? KwemaColors.ink : KwemaColors.white,
      inversePrimary: KwemaColors.tanzanite300,
    );

    // Tabular figures: fares and countdowns change digit by digit, and
    // proportional numerals make the whole row shuffle sideways each tick.
    final base = GoogleFonts.dmSansTextTheme();
    final text = base
        .apply(
          bodyColor: scheme.onSurface,
          displayColor: scheme.onSurface,
        )
        .copyWith(
          displaySmall: base.displaySmall?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.8,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
          headlineMedium: base.headlineMedium?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.6,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
          headlineSmall: base.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700,
            letterSpacing: -0.4,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
          titleMedium: base.titleMedium?.copyWith(fontWeight: FontWeight.w600),
          labelLarge: base.labelLarge?.copyWith(
            fontWeight: FontWeight.w600,
            letterSpacing: 0,
          ),
          bodySmall: base.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      textTheme: text,
      scaffoldBackgroundColor:
          isDark ? KwemaColors.darkCanvas : KwemaColors.canvas,
      splashFactory: InkSparkle.splashFactory,

      appBarTheme: AppBarTheme(
        backgroundColor: isDark ? KwemaColors.darkCanvas : KwemaColors.canvas,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0.5,
        centerTitle: false,
        titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w700),
        systemOverlayStyle:
            isDark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
      ),

      // 56px minimum height throughout. A driver taps these one-handed while
      // wearing a helmet, sometimes in rain.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(56),
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          disabledBackgroundColor: scheme.outline,
          disabledForegroundColor: scheme.onSurfaceVariant,
          textStyle: text.labelLarge?.copyWith(fontSize: 16),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(_radius),
          ),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size.fromHeight(56),
          foregroundColor: scheme.onSurface,
          side: BorderSide(color: scheme.outline, width: 1.5),
          textStyle: text.labelLarge?.copyWith(fontSize: 16),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(_radius),
          ),
        ),
      ),

      cardTheme: CardThemeData(
        color: scheme.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_radius + 4),
          side: BorderSide(color: scheme.outline),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? KwemaColors.darkSurfaceAlt : KwemaColors.white,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_radius),
          borderSide: BorderSide(color: scheme.outline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_radius),
          borderSide: BorderSide(color: scheme.outline),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_radius),
          borderSide: BorderSide(color: scheme.primary, width: 2),
        ),
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(24),
        ),
      ),

      dividerTheme: DividerThemeData(color: scheme.outline, thickness: 1),

      chipTheme: ChipThemeData(
        backgroundColor: scheme.surfaceContainerHighest,
        side: BorderSide.none,
        labelStyle: text.labelMedium,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
        ),
      ),

      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.outline,
        circularTrackColor: scheme.outline,
      ),
    );
  }

  /// Colour for a vehicle tier. Kept here rather than on the model so the
  /// palette has exactly one home.
  static Color categoryColor(String category) {
    switch (category) {
      case 'boda':
        return KwemaColors.boda;
      case 'bajaji':
        return KwemaColors.bajaji;
      case 'xl':
        return KwemaColors.xl;
      default:
        return KwemaColors.car;
    }
  }
}
