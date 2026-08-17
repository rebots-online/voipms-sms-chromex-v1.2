# Voice-ish standalone/PWA

This is the standalone-webapp lineage of Voice-ish, including the messenger UI, DID-locked reply routing, SMS/MMS history, VoxVolley recording, notifications, unread state, skins, and configurable Enter-key behaviour.

The local Node process is now a static web server only. The browser signs in to the separate reseller gateway with a Voice-ish account. VoIP.ms master API credentials stay on that gateway.

## Start

```bash
npm start
```

Open `http://127.0.0.1:8787`, enter the reseller-gateway address, and sign in. The gateway must allow this exact origin through `VOICEISH_ALLOWED_ORIGINS`.

The PWA shell can reopen offline. Sending, receiving, DID discovery, and synchronization require the gateway and Internet access.

## Check

```bash
npm run check
```

MIT licensed. No runtime package dependency, FFmpeg, GPL, or LGPL component is included.
