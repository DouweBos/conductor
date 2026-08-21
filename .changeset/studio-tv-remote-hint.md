---
"conductor-studio": patch
---

Stop the tvOS remote hint reading as a fake dynamic island.

"Click to use the remote" was a dark, pill-shaped overlay floating over the TV
picture — on Apple TV content it looked like a device artifact rather than a
Studio hint. It was also unreadable in the dark theme: the text used
`--text-inverse`, which is near-black there, on a near-black scrim.

It's now a StatusPill beside the `live · 1920×1080` label under the frame, so
it's outside the picture entirely and legible in both themes. It also hides in
inspect mode, where clicking the screen picks elements and the remote isn't what
a click does.
