# Connect Canva, YouTube, Facebook, Instagram, and TikTok

ADA signs in once from **Settings → Connections**. Paste each service's id and secret into that panel. ADA stores them on this PC, in the OS keyring when it is available and otherwise in the same private file as the login tokens. The login then happens in your browser and returns to ADA. ADA refreshes the access token before it expires.

You do not need to edit `.env` for these logins. If a value is set in `.env`, it overrides what you pasted.

YouTube's Client ID and Meta's App ID are already filled in. Those ids are public. ADA never fills in a secret. You still paste the Client Secret or App Secret yourself.

## What to do in Settings

For each service the panel shows:

1. What to paste.
2. The exact redirect URL to register, with a Copy button.
3. Save, then Connect.

Facebook and Instagram use one Meta App ID, one App Secret, and one redirect URL. Connecting either one signs in both. Disconnecting either one removes both logins. The pasted app id and secret stay saved.

Optional manual tokens still override a saved login when they are set. Those names are listed at the bottom.

## Redirect URLs to register

ADA listens on `http://127.0.0.1:8000` unless you set `ADA_PORT`. Register these exact URLs in each developer console. If you change the port, change the URL to match and register that instead.

| Service | Redirect URL |
| --- | --- |
| Canva | `http://127.0.0.1:8000/oauth/canva/callback` |
| YouTube | `http://127.0.0.1:8000/oauth/youtube/callback` |
| Facebook and Instagram | `http://127.0.0.1:8000/oauth/meta/callback` |
| TikTok | `http://127.0.0.1:8000/oauth/tiktok/callback` |

The backend prints the same four URLs when it starts.

## Where the login is stored

ADA prefers the operating-system keyring when the optional Python package `keyring` is installed (Windows Credential Manager). Otherwise it writes `%LOCALAPPDATA%\ADA\oauth_tokens.json` on Windows. That file is outside this repository. The pasted app id, the pasted secret, and the login tokens all go there. Disconnect in Settings deletes the saved login and leaves the pasted id and secret in place. Nothing in that file is written to the chat log.

Facebook and Instagram share one Meta login. Disconnecting either one removes both.

## Canva

1. Open the [Canva Developer Portal](https://www.canva.com/developers/) and create an integration. The Connect guide is [Canva authentication](https://www.canva.dev/docs/connect/authentication/).
2. Under **Outside Canva → Configuration**, copy the client ID and client secret.
3. Under **Outside Canva → Redirect URLs**, add `http://127.0.0.1:8000/oauth/canva/callback`.
4. Enable these scopes on the integration: `design:content:write`, `design:content:read`, `design:meta:read`, `asset:write`, `asset:read`, `profile:read`.
5. In ADA, open Settings → Connections → Canva. Paste the Client ID and Client Secret. Copy the redirect URL from that card if you have not registered it yet, then click **Connect**.

Optional `.env` override, if you prefer a file instead of the panel:

```
CANVA_CLIENT_ID=your_client_id
CANVA_CLIENT_SECRET=your_client_secret
```

ADA authorizes at `https://www.canva.com/api/oauth/authorize` with PKCE S256. It exchanges and refreshes the code at `https://api.canva.com/rest/v1/oauth/token` using Basic auth. The local PowerPoint, PNG, or PDF is still the file ADA writes. Canva receives an editable design when the login succeeds.

## YouTube

1. Open [Google Cloud credentials](https://console.cloud.google.com/apis/credentials).
2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Configure the OAuth consent screen and add the scopes `youtube` and `youtube.upload` (`https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/youtube.upload`).
4. Create an OAuth client of type **Desktop app**.
5. Add the authorized redirect URI `http://127.0.0.1:8000/oauth/youtube/callback`.
6. In ADA, open Settings → Connections → YouTube. The Client ID is already filled in. Paste the Client Secret, copy the redirect URL from that card, and click **Connect**.

Optional `.env` override:

```
GOOGLE_OAUTH_CLIENT_ID=your_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
```

The login asks for offline access, so Google returns a refresh token. Uploads stay private unless you set `YOUTUBE_PRIVACY`. While the Google app is in testing, sign in with an account that is on the consent screen's test users list.

## Facebook and Instagram

1. Open [Meta for Developers](https://developers.facebook.com/apps/) and create an app.
2. Add the **Facebook Login** product. In **Facebook Login → Settings**, turn on Client OAuth login and add this Valid OAuth Redirect URI: `http://127.0.0.1:8000/oauth/meta/callback`.
3. Add Instagram Graph API access for the same app. The Instagram account must be a professional account linked to a Facebook Page you manage.
4. Add your Facebook user as an admin, developer, or tester while the app is in development mode. These permissions are enough for that role on your own Page: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management`. Posting for other people later needs Meta App Review.
5. In ADA, open Settings → Connections → Facebook. The App ID is already filled in. Paste the App Secret, copy the redirect URL from that card, and click **Connect**. Instagram uses the same values.

Optional `.env` override:

```
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
```

ADA exchanges the code for a short-lived user token, exchanges that for a long-lived user token, then reads your Pages. The Page token derived from the long-lived user token does not expire. ADA also reads `instagram_business_account` on that Page. If you manage more than one Page, set `FACEBOOK_PAGE_ID` to the Page id you want before you click Connect. Leave `FACEBOOK_PAGE_ACCESS_TOKEN` empty if you want the saved login to be used.

Instagram and TikTok have no public API that starts a livestream. ADA will say so. Facebook and YouTube return an RTMP address.

## TikTok

1. Open [TikTok for Developers](https://developers.tiktok.com/) and create an app.
2. Add the **Login Kit** product. Register this redirect URI: `http://127.0.0.1:8000/oauth/tiktok/callback`. Desktop redirect URLs must be `http://127.0.0.1` with the port.
3. Add the scopes `user.info.basic`, `video.publish`, and `video.upload`. `video.publish` often stays unavailable until TikTok approves it for the app.
4. In ADA, open Settings → Connections → TikTok. Paste the Client Key and Client Secret, copy the redirect URL from that card, and click **Connect**.

Optional `.env` override:

```
TIKTOK_CLIENT_KEY=your_client_key
TIKTOK_CLIENT_SECRET=your_client_secret
```

TikTok desktop login uses PKCE. ADA sends the hex SHA-256 challenge TikTok requires, with method `S256`. Posts stay `SELF_ONLY` unless you set `TIKTOK_PRIVACY_LEVEL`. Videos larger than 64 MB are refused. There is no TikTok livestream-start API.

## Optional manual overrides

These replace the saved login for that service. Leave them unset when you use Connect.

```
CANVA_ACCESS_TOKEN=
YOUTUBE_ACCESS_TOKEN=
YOUTUBE_PRIVACY=private
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=
INSTAGRAM_USER_ID=
INSTAGRAM_ACCESS_TOKEN=
TIKTOK_ACCESS_TOKEN=
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
```

Ask ADA which accounts are connected. The answer comes from this computer and does not include the tokens.
