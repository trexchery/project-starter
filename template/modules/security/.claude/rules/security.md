---
paths:
  - "**/auth/**"
  - "**/*auth*.*"
  - "**/*session*.*"
  - "**/*login*.*"
  - "**/*password*.*"
  - "**/*payment*.*"
  - "**/billing/**"
  - "**/checkout/**"
  - "**/*webhook*.*"
  - "**/middleware*.*"
  - "**/*permission*.*"
---
This file is security-sensitive ({{sensitiveList}}). Follow the "Sensitive areas" rules in AGENTS.md, add a test for
every rule you rely on, and have the `security` agent review the diff before the pull request is marked ready.
