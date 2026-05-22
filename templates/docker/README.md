# Clean Room Docker Profiles

These templates build optional verification images for Agent 3. They do not run agents in containers and they do not replace hook policy.

Build the first-phase profiles:

```bash
docker compose -f templates/docker/compose.clean-room.yml build
```

The Agent 3 verification runner uses these image names:

- `clean-room-skill/node22:local`
- `clean-room-skill/python312:local`
- `clean-room-skill/go126:local`
- `clean-room-skill/rust-stable:local`

Clean verification containers mount only clean-safe roots:

- selected implementation root at `/work` read/write
- clean artifact roots at `/clean`, `/clean-1`, ... read-only
- schema root at `/schemas` read-only
- approved public/reference roots at `/refs/<n>` read-only

Source roots and contaminated artifact roots must never be mounted into clean verification containers. Networked dependency installation is out of scope for the first Docker milestone; use `network: "off"` and `dependency_mode: "offline"` or `"locked"`.
