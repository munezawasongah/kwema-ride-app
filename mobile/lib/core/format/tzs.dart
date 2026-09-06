/// TZS formatting.
///
///  * No circulating subunit — never render "TSh 3,450.00", it reads broken.
///  * Symbol precedes the amount, comma thousands separator.
///  * Amounts are integer cents internally; division happens only at the edge.
///  * The number format does not change with locale. Tanzanians write TZS the
///    same way in Swahili, English and French, so only the surrounding words
///    are translated.

import 'package:intl/intl.dart';

final NumberFormat _tzs = NumberFormat.decimalPattern('en');

/// "TSh 3,450"
String formatTzs(int cents) => 'TSh ${_tzs.format((cents / 100).round())}';

/// Compact form for tight spaces such as the category carousel. Below
/// 10,000 TZS the full number fits and is clearer than an abbreviation.
String formatTzsCompact(int cents) {
  final shillings = (cents / 100).round();
  if (shillings < 10000) return _tzs.format(shillings);
  return '${(shillings / 1000).toStringAsFixed(1)}K';
}

/// Tolerant of "3,450", "3450", "TSh 3450".
int? parseTzsToCents(String input) {
  final cleaned = input.replaceAll(RegExp(r'[^0-9]'), '');
  return cleaned.isEmpty ? null : int.parse(cleaned) * 100;
}

/// "1.4 km" / "600 m"
String formatDistance(int metres) =>
    metres < 1000 ? '$metres m' : '${(metres / 1000).toStringAsFixed(1)} km';
