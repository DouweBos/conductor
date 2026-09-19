---
'@houwert/conductor': patch
---

Crop `take-screenshot` to an element on the inner panel of a foldable. The crop
scaled the element's bounds using `deviceInfo()`, which describes
`XCUIScreen.main` — the cover panel — while the hierarchy and the redirected
capture are both in the inner panel's coordinate space, overshooting every crop
by 1.43x on an iPhone Duo. The scale now comes from the captured panel's own
`pointScale`. Cropping against a panel that is powered off reports why instead.
