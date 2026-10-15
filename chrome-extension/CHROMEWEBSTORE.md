# Chrome Web Store Listing & Readiness — Nexlev Studio Overlay

**Last Updated:** 2026-10-15
**Version:** 1.0.0

## Summary Description
Displays video Outlier ratios, estimated RPM ranges, homepage filters, and a one-click idea saver directly on YouTube browse and search pages.

## Permissions Justification
- `storage`: Stores your filter preferences and saved Swipe File counter locally across browser sessions.
- `tabs`: Opens the local Nexlev Studio dashboard in a new browser tab when clicked from the extension popup.
- `host_permissions` (`https://www.youtube.com/*`, `http://localhost:3088/*`): Injects Outlier badges and filter controls on YouTube pages and syncs saved video ideas with your local Nexlev Studio dashboard.

## Privacy & Data Use
All video metrics are computed locally in your browser or synced exclusively to your local Nexlev Studio workspace (`http://localhost:3088`). No personal browsing history is sold or transmitted to third-party servers.

## Version History
- **1.0.0 (2026-10-15)**: Initial release with YouTube Homepage Outlier Filter Bar, Outlier & RPM badges, Thumbnail Title Tester, and Swipe File sync.
