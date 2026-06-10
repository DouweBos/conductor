---
"@houwert/conductor": patch
---

Fix `take-screenshot --id/--text/<query>` cropping the wrong region on retina iOS and 4K tvOS. The crop pipeline derived its AX→pixel scale from the synthetic root `axElement.frame`, which is always zero, so bounds in logical points were applied as pixel coordinates and the crop landed in the top-left quadrant. Scale is now sourced from `deviceInfo`, and `--margin` is interpreted in the same logical units as the bounds it pads. Also adds the missing `-o` shorthand for `--output`.
