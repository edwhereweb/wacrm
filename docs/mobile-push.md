# Mobile app push notifications

The EdWhere CRM mobile app gets push notifications through the Expo push
service, which relays to Firebase Cloud Messaging (Android) and APNs (iOS).

| Event | Who is notified |
| --- | --- |
| Customer message on an assigned chat | The assignee |
| Customer message on an unassigned chat | Every agent, admin and owner |
| A chat is assigned to someone (web or app) | That person |

Notifications show the contact's name and up to 100 characters of the message.

## Setup

1. **Apply** `supabase/migrations/068_mobile_devices.sql`.
2. **Optional:** set `EXPO_ACCESS_TOKEN` if "enhanced push security" is turned on for the
   Expo project. Without it, pushes are sent unauthenticated, which Expo allows by default.
3. **Assignment pushes** need a Supabase Database Webhook, because assignments made on the
   web are written straight from the browser and never pass through a server route:
   - Set `MOBILE_PUSH_WEBHOOK_SECRET` to a long random string in the app's environment.
   - In Supabase: **Database → Webhooks → Create a new hook**.
     - Table: `public.notifications`, event: **Insert**.
     - Type: HTTP Request, method `POST`,
       URL `https://wacrm.edwhere.com/api/mobile/v1/internal/notification-push`.
     - HTTP header `x-webhook-secret` set to the same secret.

   Without step 3, message pushes still work; only assignment pushes are missing.

Message pushes are sent from the WhatsApp webhook after the inbound message
is stored (`notifyInboundMessage` in `src/lib/mobile/push.ts`). Tokens that
Expo reports as uninstalled are deleted automatically.
