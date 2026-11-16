# Changelog

## 1.0.0

First release.

- Small (2×2), medium (4×2) and large (4×4) home-screen widgets with glass tiles and segmented meters
- CPU, RAM, disk, temperature, uptime, network speed and Docker container status from Glances
- Large widget: temperature list, 12-hour CPU/RAM trend graph, list of containers that are down
- Lock-screen widgets: circular, rectangular and inline
- Offline cache: shows the last good reading with its age when the NAS is unreachable
- `▲` / `‼` alert marks that stay visible in tinted and clear widget modes
- Per-widget settings through the widget Parameter field
- Optional tap links for the disk tile and Docker pill
- Experimental drive temperatures through Glances' SMART plugin
- Widget sizes looked up from the phone's screen size, with a `sizeOverride` setting
