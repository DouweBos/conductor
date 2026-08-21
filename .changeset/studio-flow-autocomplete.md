---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Autocomplete Maestro flow YAML in the editor: commands where a step goes, that
command's parameters inside its block (element-selector keys included), the
header keys above the `---`, and env variables inside `${…}`. The vocabulary is
transcribed from Maestro's own YAML command models, and env names are collected
from every `env:` block and `${VAR}` in the flows directory plus its
`config.yaml`, so a new flow can be written against the suite's existing
parameters.
