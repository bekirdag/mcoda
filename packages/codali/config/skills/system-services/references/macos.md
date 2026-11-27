# macOS launchd host access

Use an advertised authorized macOS host connector. Distinguish the system domain from the relevant user's GUI/domain and LaunchAgent from LaunchDaemon. Inspect the observed label and plist path; do not translate Linux systemctl commands to macOS or invent a domain identifier.

Consult the host's launchctl help/man page for its installed version before applying a lifecycle operation. Preserve the plist and execution identity, validate changes, and use the existing service owner/deployment method. Loading a job does not prove the application is ready; inspect status, bounded logs and the application endpoint after an authorized change.

Never claim macOS host access from a Linux sandbox. A user agent may depend on the user's login session; explain that persistence limitation when relevant.

Source: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html (archived conceptual guidance; check local commands).
