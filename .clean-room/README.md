# Clean Room Bootstrap

This repository has a clean-room bootstrap stub.

Active clean-room run artifacts are stored outside this repository. The bootstrap task root contains per-task `contaminated/`, `clean/`, and `quarantine/` directories. The project root contains the shared `implementation/` clean destination. Do not commit source roots, contaminated artifact paths, private identifiers, source-derived names, or active `init-config.json`, `task-manifest.json`, or `clean-run-context.json` files here.

The final clean polish stage may create or update implementation-root `AGENTS.md`, `.gitignore`, and one local git commit through the bounded Agent 4 polish runner. That commit belongs to the clean implementation root, not to contaminated artifacts or source roots.

Default target profile: `speckit-feature-folder`

Start the runtime skill from your agent and provide the external task root printed by `clean-room-skill init`.
