# Security

Melina executes model-directed commands in task containers and reads or writes task workspaces. Run it only with trusted users and authorized task inputs.

The server binds to `127.0.0.1` and validates request Host and Origin. These checks do not provide user authentication. Put an authenticated reverse proxy in front of any network deployment; do not expose it directly as a public or multi-tenant service.

Prefer rootless Podman or Docker and grant task containers only the files, network access, and credentials they need. API keys and configured credentials are encrypted locally; possession of both the database and its key allows decryption. Keep the data directory, backups, and `MELINA_SECRET_KEY` private.

Report suspected vulnerabilities through GitHub private vulnerability reporting if enabled. Otherwise, open an issue requesting a private contact channel without including credentials or exploit details.
