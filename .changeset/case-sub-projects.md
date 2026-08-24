---
"conductor-studio": minor
---

Support several projects in one repo. A monorepo holding a mobile app and a tv app can now mirror a Qase project for each: the Cases toolbar switches between them, and "all projects" merges them into one read-only matrix.

Each sub-project owns its cases, plans, results, Qase project code and API token, plus a Maestro tag that scaffolded flows are given and a default device its runs start on. Authoring, importing and syncing require a single sub-project to be selected, since a new case has to land somewhere.

Existing setups migrate on first read: the repo's datasource becomes a sub-project called `default` and its cases, plans and results move under it.
