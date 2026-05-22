---
"@houwert/conductor": patch
---

Speed up iOS replay. Simple selectors (a single plain text/id) now resolve through a direct runner query instead of dumping the whole view hierarchy, the hierarchy is briefly cached between commands, and `start-device` prewarms the driver so the first interaction no longer pays the XCTest startup cost. Vertical swipes are also lifted clear of the on-screen keyboard, and dropped text input is retyped automatically.
