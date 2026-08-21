---
"conductor-studio": minor
---

Give folders a real context menu in the flow tree, and scaffold new flows from
templates.

Right-clicking a folder offered nothing you could do to a folder — no way to add
a file to it, which is the one thing a file tree is for. Folders now get the same
menu as files: new flow / new folder here (prefilled with the folder, or with a
file's parent), rename, duplicate, copy relative / aliased / absolute path,
reveal in Finder, delete. Renaming a folder repoints every reference to the files
inside it, and duplicating one copies its contents.

**New flow** now scaffolds from a template — blank, page object subflow or tagged
case out of the box, plus whatever the project puts in
`<flowsDir>/.templates/<id>.yaml.tmpl`. Templates are flows with
`{{placeholders}}`, since `${…}` already belongs to Maestro at run time; `name`,
`path`, `dir`, `date` and `appId` fill themselves in, and any other `{{var}}`
becomes a field in the dialog. The `.tmpl` suffix keeps templates out of runs
without a `config.yaml` exclusion — every flow scanner matches on a
`.yaml`/`.yml`/`.js` extension.
