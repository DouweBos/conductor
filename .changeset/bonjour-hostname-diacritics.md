---
'@houwert/conductor': patch
---

Fix reaching a physical device whose name has accented letters. The Bonjour hostname conductor derives from the name turned each accented letter into a dash, so an Apple TV named "Pokój dzienny" was looked up as` Pok-j-dzienny.local` instead of the `Pokoj-dzienny.local` it advertises. Accents are now dropped first.
