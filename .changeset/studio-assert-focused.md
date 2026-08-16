---
"conductor-studio": minor
---

Suggest an `assertVisible … focused: true` for a focused element.

On a focus-driven UI "is it visible" is the weaker half of the check — the point
of a D-pad flow is that focus landed where you meant it to. Picking a focused
element now offers that assertion alongside the plain one, using the `focused:`
selector the resolver already supports on every platform. An unfocused element
gets the inverse, `focused: false`, but only on tvOS — there exactly one element
holds focus, so "not this one" is a real check, while on touch it would pass
without testing anything.

Fixes the state that made this visible in the first place: `traits` is
`[type, ...states]`, so an element whose type has no mapping took its *state* as
its role — which is why plain containers read as "disabled" or "focused" as
though that were what they are. Role now skips the state traits, and focus is
carried as its own field (iOS `hasFocus`, web `focused`, Android `state.focused`).
