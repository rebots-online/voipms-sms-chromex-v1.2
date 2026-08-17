# Voice-ish

Voice-ish is a permissively licensed SMS/MMS client for a managed VoIP.ms reseller service. End users sign in with an ordinary Voice-ish email and password. They never enter, receive, or store the reseller's VoIP.ms master API credentials.

## Repository layout

- `/` — Manifest V3 Chrome extension.
- `/apps/standalone` — installable standalone/PWA client with VoxVolley.
- `/services/reseller-gateway` — PostgreSQL-backed account service and reseller-scoped VoIP.ms gateway.
- `/docs/ARCHITECTURE.md` — trust boundaries, data ownership, billing seam, and API contract.

## Security boundary

```text
Voice-ish user → Voice-ish session → reseller gateway → VoIP.ms
                                      ↑
                         master API credentials stay here
```

The gateway resolves the session to one local account and one VoIP.ms reseller-client ID. It rejects arbitrary VoIP.ms methods, rejects caller-supplied client IDs or upstream credentials, injects the mapped reseller-client ID, and validates the sending DID against that account.

New registration deliberately creates a local account in `pending` state. It does not create or fund a VoIP.ms client until package, payment, address/E911, and rollback policy have been decided.

## Gateway setup

1. Create a PostgreSQL database.
2. Apply `services/reseller-gateway/db/migrations/001_initial.sql`.
3. Copy `services/reseller-gateway/.env.example` into your secret-management system and set the values.
4. Add the PWA origin and any packaged extension origin to `VOICEISH_ALLOWED_ORIGINS`.
5. Start the service:

```bash
cd services/reseller-gateway
npm install
npm start
```

After a user registers, provision their already-created local account with an administrator-only call:

```bash
curl -X PUT "https://voice.example/v1/admin/tenants/TENANT_ID/voipms" \
  -H "Authorization: Bearer $VOICEISH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reseller_client_id":"CLIENT_ID","dids":["6135550100"],"subaccounts":[{"account":"100001","label":"Main phone"}]}'
```

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

The focused gateway suite proves the scope failures that matter most: a caller cannot replace the reseller-client ID, cannot supply master credentials, cannot invoke arbitrary upstream methods, and cannot send from another client's DID.

## License

MIT. No FFmpeg, GPL, or LGPL component is included.
