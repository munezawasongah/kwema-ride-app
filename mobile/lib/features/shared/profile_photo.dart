/// Profile photo: display and upload.
///
/// LATRA's operator-licence app test requires the rider to see the driver's
/// name and photo, so this is a licensing requirement rather than a nicety.
///
/// The image is compressed on the device before upload — a modern phone
/// camera produces 4–8 MB files, and sending that over a metered 3G
/// connection to store a 40 KB avatar is indefensible.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/l10n/localization.dart';
import '../../core/network/api_client.dart';

/// Read-only avatar, used wherever one person is shown to another.
class ProfilePhoto extends StatelessWidget {
  const ProfilePhoto({
    super.key,
    required this.name,
    this.photoUrl,
    this.radius = 22,
  });

  final String name;
  final String? photoUrl;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final initial = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();

    return CircleAvatar(
      radius: radius,
      backgroundColor: theme.colorScheme.primary,
      foregroundImage: (photoUrl != null && photoUrl!.isNotEmpty)
          ? NetworkImage('$kApiBaseUrl$photoUrl')
          : null,
      // Shown while the image loads and if it fails, so there is never an
      // empty circle on a weak connection.
      child: Text(
        initial,
        style: TextStyle(
          color: Colors.white,
          fontSize: radius * 0.8,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

/// The person's own avatar, tappable to replace.
class EditableProfilePhoto extends ConsumerStatefulWidget {
  const EditableProfilePhoto({super.key, this.radius = 32});
  final double radius;

  @override
  ConsumerState<EditableProfilePhoto> createState() =>
      _EditableProfilePhotoState();
}

class _EditableProfilePhotoState extends ConsumerState<EditableProfilePhoto> {
  bool _busy = false;

  Future<void> _pick(ImageSource source) async {
    final picker = ImagePicker();
    // Constrained at capture: the server resizes again, but shipping a full
    // camera frame over 3G to produce a 40 KB avatar wastes the person's
    // bundle and their time.
    final file = await picker.pickImage(
      source: source,
      maxWidth: 1024,
      maxHeight: 1024,
      imageQuality: 85,
    );
    if (file == null) return;

    setState(() => _busy = true);
    try {
      final bytes = await file.readAsBytes();
      await ref.read(apiClientProvider).post('/users/me/photo', {
        'image': base64Encode(bytes),
      });
      ref.invalidate(profileProvider);
      if (mounted) {
        // Cached NetworkImages keep the old photo otherwise.
        imageCache.clear();
        imageCache.clearLiveImages();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _choose() async {
    final l10n = AppLocalizations.of(context);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: Text(l10n.translate('photo.camera')),
            onTap: () { Navigator.pop(ctx); _pick(ImageSource.camera); },
          ),
          ListTile(
            leading: const Icon(Icons.photo_library_outlined),
            title: Text(l10n.translate('photo.gallery')),
            onTap: () { Navigator.pop(ctx); _pick(ImageSource.gallery); },
          ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final profile = ref.watch(profileProvider);
    final name = profile.maybeWhen(
      data: (p) => p['fullName']?.toString() ?? '',
      orElse: () => '',
    );
    final url = profile.maybeWhen(
      data: (p) => p['photoUrl']?.toString(),
      orElse: () => null,
    );

    return Semantics(
      button: true,
      label: AppLocalizations.of(context).translate('photo.change'),
      child: GestureDetector(
        onTap: _busy ? null : _choose,
        child: Stack(
          alignment: Alignment.bottomRight,
          children: [
            ProfilePhoto(name: name, photoUrl: url, radius: widget.radius),
            Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                color: theme.colorScheme.surface,
                shape: BoxShape.circle,
                border: Border.all(color: theme.colorScheme.outline),
              ),
              child: _busy
                  ? const Padding(
                      padding: EdgeInsets.all(5),
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : Icon(Icons.camera_alt,
                      size: 13, color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
