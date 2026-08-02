# Voice-ish for VoIP.ms — permissive build

A compact Manifest V3 Chrome extension for sending and receiving VoIP.ms SMS and MMS messages from the toolbar. Its visual target is the practical early-2010s Google Voice popup rather than a CRM.

## What works

- Direct VoIP.ms REST/JSON login using the account email and API-specific password.
- Displays the public IP VoIP.ms sees so it can be added to the API allow-list.
- Retrieves account DIDs and lets the user choose which messaging numbers appear.
- Sends SMS up to 160 characters and MMS for longer text or attachments.
- Configurable keyboard behavior: Enter sends with Shift+Enter for a newline, or Enter makes a newline with Ctrl/⌘+Enter to send.
- Attaches up to three already-compatible JPG, GIF, JPEG, PNG, MP3, WAV, MIDI, MP4, or 3GP files.
- Enforces a conservative maximum of 1,200,000 bytes per attachment.
- Polls SMS and MMS history, caching up to 2,000 messages locally.
- Offers 7, 30, 90, 365-day and all-available history windows.
- Polls every minute in the background and every 15 seconds while open.
- Shows desktop notifications and an unread badge.
- Keys every conversation by **your DID + the other number**. A reply remains pinned to the DID that received the conversation.

## Video limitation

This build intentionally contains no FFmpeg, WebAssembly transcoder, codec library, remote conversion service, or other copyleft dependency.

Video must already be:

1. An `.mp4` or `.3gp` file.
2. No larger than 1,200,000 bytes.
3. Encoded with codecs accepted by the destination carrier. The extension can validate the container name and byte size, but not codec compatibility.

If a clip does not meet those conditions, compress or trim it in a separate application before attaching it. The extension rejects oversized or unsupported video instead of pretending it will probably work.

## Why the bearer token is not used

VoIP.ms documents the portal's bearer token for 3CX and similar PBX messaging integrations. The public REST/JSON endpoint used for DID discovery, message history, SMS, and MMS still requires `api_username`, `api_password`, and an allow-listed source IP. This extension therefore uses the documented REST credentials and does not store an unused bearer token.

## Install unpacked

1. In VoIP.ms, open **Main Menu → SOAP & REST/JSON API**.
2. Enable API access and create an API-specific password.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Open Voice-ish and add its displayed public IP to the VoIP.ms allow-list.
6. Enter the account email and API password.

## Security limitation

This deliberately quick local build stores the API email, API password, message cache, and attachments in `chrome.storage.local`. It is not an encrypted secret vault. Use a dedicated API password and install it only in a trusted Chrome profile and operating-system account.

Requests go directly from the extension to `https://voip.ms/api/v1/rest.php`; there is no intermediary server.

## 0.2.1 send-path repair

- New-message routes now survive the popup's 15-second history refresh.
- The composer no longer silently exits when its transient conversation row is refreshed away.
- Send progress and API errors remain visible in the composer instead of appearing only as a short toast.
- Canadian/US `+1` numbers are normalized to the 10-digit format required by the VoIP.ms messaging API.
- Both API calls and popup requests have finite timeouts.

## Deliberately absent

- Built-in video or audio conversion.
- Contacts/address-book integration.
- Hosted webhook or push relay; incoming messages appear by polling.
- Encrypted local message storage.
- Group MMS threading.

## License

MIT. This package has no runtime dependencies and contains no GPL or LGPL component.

## Development checks

```bash
node --check background.js
node --check popup.js
python3 -m json.tool manifest.json >/dev/null
```

Live send/receive testing requires a VoIP.ms account, an SMS-enabled DID, API access, and the test machine's public IP on the account's API allow-list.
