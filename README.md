# Voice-ish

Voice-ish is a permissively licensed SMS/MMS client for a managed VoIP.ms reseller service. End users sign in with an ordinary Voice-ish email and password. They never enter, receive, or store the reseller's VoIP.ms master API credentials.

## Repository layout

- `/` — Manifest V3 Chrome extension.
- `/apps/standalone` — installable standalone/PWA client with VoxVolley.
- `/services/reseller-gateway` — initializer, operator console, account service, and reseller-scoped VoIP.ms gateway.
- `/docs/ARCHITECTURE.md` — trust boundaries, data ownership, billing seam, and API contract.

## Security boundary

```text
Voice-ish user → Voice-ish session → reseller gateway → VoIP.ms
                                      ↑
                         master API credentials stay here
```

The gateway resolves the session to one local account and one VoIP.ms reseller-client ID. It rejects arbitrary VoIP.ms methods, rejects caller-supplied client IDs or upstream credentials, injects the mapped reseller-client ID, and validates the sending DID against that account.

New registration deliberately creates a local account in `pending` state. It does not create or fund a VoIP.ms client until package, payment, address/E911, and rollback policy have been decided.

## Installer/initializer

Run `install-voiceish.cmd` on Windows or double-click/run `install-voiceish.sh` on Linux/macOS. The launcher installs the gateway dependency and opens the local initializer automatically.

The guarded five-stage GUI:

1. selects the local/public service address and exact allowed application origins;
2. tests PostgreSQL and applies every unapplied migration;
3. verifies the VoIP.ms reseller API credentials without returning them to the browser;
4. creates the first platform operator and can map its reseller client, numbers, and phones;
5. generates the internal administrator token, writes an owner-readable configuration, locks setup, and launches the service.

No SQL command, `.env` editing, token generation, or provisioning `curl` is part of the interactive setup path. Environment variables remain supported for unattended deployments; runtime startup still applies migrations automatically.

After installation, open `{service address}/admin/`. The operator console lists new/pending customer accounts and provides the ongoing GUI for reseller-client, number, and phone mapping. The internal service token is never sent to that console.

## Chrome extension

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the repository root. On first sign-in Chrome requests access only to the Voice-ish service origin entered by the user.

## Standalone/PWA

```bash
cd apps/standalone
npm start
```

Open `http://127.0.0.1:8787`. This server serves static app files only; it no longer relays caller-supplied VoIP.ms credentials.

## Checks

```bash
npm test
```

The focused suite proves both initialization and reseller boundaries: a caller cannot drive setup without its one-time local authorization, remote origins require HTTPS, stored secrets are owner-readable, a customer cannot replace the reseller-client ID or master credentials, arbitrary upstream methods are rejected, and a customer cannot send from another account's DID.

## License

MIT. No FFmpeg, GPL, or LGPL component is included.
