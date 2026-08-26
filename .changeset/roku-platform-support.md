---
'@houwert/conductor': minor
---

Add Roku support. Roku devices are driven over the network with the External
Control Protocol (ECP): the view hierarchy comes from `/query/app-ui` and is
re-emitted as uiautomator XML so the existing element resolver handles it, input
goes out as `/keypress/<key>` D-pad presses, text as `LIT_` keypresses, and
screenshots through the developer web server's `/plugin_inspect` (digest auth).

Physical hardware only — there is no emulator and no driver process. Pin a device
with `CONDUCTOR_ROKU_HOST`, set `CONDUCTOR_ROKU_PASSWORD` for screenshots, and
opt into an SSDP LAN scan with `CONDUCTOR_ROKU_DISCOVERY`. Devices appear as
`roku:<host>`. The device needs developer mode plus "Control by mobile apps"
network access set to Permissive.

Also adds the `Remote Info`, `Remote Instant Replay`, and `Remote Search` keys to
`press-key`, mapped on both Roku and Android.
