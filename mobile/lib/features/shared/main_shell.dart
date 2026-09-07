/// Bottom navigation shell: Home, Activity, Account.
///
/// IndexedStack rather than swapping the child: rebuilding the map every time
/// someone checks their history would re-create the GoogleMap widget, re-fetch
/// tiles, and lose the camera position. On a metered connection that is a real
/// cost, not just a jank issue.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/l10n/localization.dart';
import 'account_screen.dart';
import 'activity_screen.dart';

class MainShell extends ConsumerStatefulWidget {
  const MainShell({super.key, required this.home, this.isDriver = false});

  final Widget home;
  final bool isDriver;

  @override
  ConsumerState<MainShell> createState() => _MainShellState();
}

class _MainShellState extends ConsumerState<MainShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [
          widget.home,
          ActivityScreen(isDriver: widget.isDriver),
          AccountScreen(isDriver: widget.isDriver),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        // 68px: the default 80 eats too much of a small screen, but going
        // below this makes the targets awkward for a driver wearing gloves.
        height: 68,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.home_outlined),
            selectedIcon: const Icon(Icons.home),
            label: l10n.translate('nav.home'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.receipt_long_outlined),
            selectedIcon: const Icon(Icons.receipt_long),
            label: l10n.translate('nav.activity'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.person_outline),
            selectedIcon: const Icon(Icons.person),
            label: l10n.translate('nav.account'),
          ),
        ],
      ),
    );
  }
}
