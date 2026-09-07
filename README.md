# buzz-relay-dm-bridge

Bridge one channel on one relay to one direct-message thread on another relay,
using a single identity that is a member of both.

You mention the bridge in a channel on your own relay. Your words — exactly as
you typed them, minus the mention itself — arrive as a direct message to one
person on their relay. When they reply, the reply is posted back into your
channel and tagged so it notifies you. Nothing else on either relay is touched.

It is a chat window onto one person, built out of two relay memberships and
about five hundred lines of Node.

It targets relays that speak the Buzz extensions to nostr: channels addressed
by an `h` tag, direct-message threads opened with a kind-41010 command whose
acknowledgement carries the thread id, and plaintext kind-9 messages inside
them. It is not a general NIP-04 or NIP-17 client.

## How it decides what to move

Four gates, all evaluated on parsed event tags and never on message text:

| Gate | Rule |
|---|---|
| Own events | Any event signed by the bridge's own key is dropped first, on both sockets, before anything else. The bridge is a member of both channels it writes into, so its own messages come back to it. |
| Mention | An outbound message must carry a `p` tag naming the bridge. Writing its name in the body is not enough — a bridge that read its own name out of message text could be driven by anyone who could type it. |
| Author | The outbound message's author must be in `ALLOWED_AUTHORS`. Without this, anyone ever added to the channel can send text to the far peer under your name. |
| Peer | An inbound message must be authored by `FAR_PEER_PUBKEY`. Everything else in that thread — system messages, a third participant — is dropped. |

Every drop is logged with the event id and the gate that rejected it. Nothing
is dropped silently.

## What it does not do

- **A file's link does not cross; the file does.** See below — nothing that
  arrives is ever a URL onto the other relay, because such a URL is unopenable
  by definition.
- **No threading.** A direct message carries no reference to which of your
  messages it answers, so any threading would be a guess. Replies land flat.
- **No splitting.** A message over the relay's frame limit is refused with its
  size, rather than chunked. A silently split message is not your exact words.
- **It never speaks to the far peer on its own.** Errors surface in your
  channel only.

## How a file crosses

A relay's blobs are auth-gated to that relay's members, so forwarding a URL
forwards a link the recipient cannot open. The bridge therefore carries the
bytes: it downloads the blob from the source relay with its own key, uploads
it to the destination relay with the same key, and rewrites the message to
point at the copy. Both legs are Blossom, authorized by a kind-24242 event —
the same membership the websocket already proves, with no second credential.

Four things that fall out of doing it this way, all of them deliberate:

- **A copy is permanent.** After a file crosses, it exists on both relays,
  content-addressed, readable by any member of either who has the URL. That is
  what "the recipient can open it" means, and it cannot be walked back.
- **The body is rewritten, not just the tag.** Clients render an image from
  the URL in the message body and read the `imeta` tag only as metadata for a
  URL already written there, so rewriting the tag alone would ship a message
  that still points at the unreachable original. A file the sender's client
  put only in the tags is appended to the body rather than carried invisibly.
- **The words always travel.** Every refusal — too large, a hash that does not
  match, a relay that will not hand the blob over — leaves the text on its way
  and reports what happened to the file. Only a message that was *nothing but*
  a file that failed is withheld, because there would be nothing left to send.
- **Size is capped well below what the relays accept, per message.** Carriage
  happens inside the queue that keeps messages in order, so a large file
  delays the messages behind it — and ten files just under a per-file limit
  would delay it just as long. `MAX_ATTACHMENT_BYTES` defaults to 25 MB and
  bounds the whole message: whatever fits crosses, and the text goes either
  way with a line saying what did not.

`DROP_ATTACHMENTS=true` turns all of this off and puts the bridge back to
text-only, saying so in the channel in both directions rather than dropping a
file in silence.

## Running it

```
npm install
cp .env.example .env    # fill it in
npm start
```

`DRY_RUN=1` signs and logs every event it would publish without sending it —
useful for proving the routing without touching either relay.

`node src/index.mjs --healthcheck` reads the state directory and exits
non-zero if the heartbeat is stale. There is no HTTP port; nothing listens.

See [`.env.example`](.env.example) for the full configuration surface and
[`systemd/buzz-relay-dm-bridge.service`](systemd/buzz-relay-dm-bridge.service) for a
hardened unit file.

## Restarts, replays and duplicates

Three separate problems with three separate mechanisms:

- **A first boot never looks backwards.** Replaying a channel's back-scroll on
  a cold start would mean delivering its history to the far side as if you had
  just typed it. A restart resumes from the last delivered event minus sixty
  seconds, because `created_at` is second-granular and a relay may order
  same-second events differently across a reconnect.
- **A source event id is recorded only after the destination relay
  acknowledges the forwarded event.** A crash between the two costs at most one
  duplicate, which is visible and self-correcting. Recording first would
  instead lose a message whose publish had failed, silently.
- **Deleting the state directory is safe.** The bridge re-opens the peer thread
  (the relay's open is idempotent on the participant set) and cold-starts. It
  forwards nothing old and re-sends nothing.

The two relay connections reconnect independently, 1s backing off to 60s. The
far relay being down does not disturb the home side, and an inbound reply is
not marked delivered until the home relay acknowledges it — so a home-side
outage delays a reply rather than losing it.

## The key, and why there is no rotation

The bridge holds one private key and uses it on both relays. That key is the
identity, and on this protocol **an identity cannot be rotated** — a new key is
a new identity, and every membership, every profile, and the direct-message
thread itself are bound to the old one.

If the key leaks, whoever holds it can post as the bridge in any channel it
belongs to, open direct messages with anyone that relay lets it reach, and
rewrite its profile. It cannot read channels it is not a member of, and cannot
add itself to one — that takes an administrator. **Containment is relay
membership.** Keep the identity's membership list to exactly the two places it
needs, and treat "revoke it on both relays" as the incident response.

Replacing a compromised key is therefore a migration, not a rotation:

1. Mint a new identity and have an administrator admit it on both relays.
2. Swap `BRIDGE_PRIVATE_KEY` in the environment file.
3. Delete `cursor.json` so the peer thread is opened fresh. **This creates a
   new thread.** The old conversation stays where it is, and the far peer will
   see a message from a new identity.
4. Restart, and tell the person on the other side.

## Configuration

Everything site-specific is an environment variable — relay hostnames, channel
ids, pubkeys, the display name. None of them appear in this repository, and
none of them have defaults. See [`.env.example`](.env.example).

`BOT_DISPLAY_NAME` deserves one note: it must match the bridge's relay profile
name exactly, because it is the token stripped from your message before
forwarding. Get it wrong and your mention travels along with your words.

## Setting the profile

```
npm run set-profile              # print what would change, publish nothing
npm run set-profile -- --commit  # publish it
npm run set-profile -- --far     # also target the far relay
```

Kind 0 is replaceable, so a profile assembled from `BOT_DISPLAY_NAME` and
`BOT_ABOUT` alone would delete every field those two do not name — the avatar
first and most visibly. This reads the profile the relay already holds, lays
the configured fields over it, and writes the whole object back. An unset
`BOT_ABOUT` leaves an existing about line alone rather than clearing it.

It refuses rather than guesses. If the relay does not send end-of-stored-events
inside fifteen seconds, or holds a profile whose content will not parse as a
JSON object, it exits non-zero having published nothing.

The name is written to both `name` and `display_name` from the one variable,
because clients disagree about which they index for a mention picker and the
two drifting apart is the failure `BOT_DISPLAY_NAME` exists to prevent.

Renaming is home-side only by default. Nothing on the far side routes on the
name — the inbound gate matches on pubkey and thread id — so `--far` is a
choice about how the bridge reads to the person on the other end.

This is the supported way to set the profile. `PUBLISH_PROFILE=1` is the older
startup path, it does not merge, and it should stay unset on any deployment
whose profile has an avatar.

**After a rename, change `BOT_DISPLAY_NAME` to match and restart.** Between the
two the picker inserts a name the bridge no longer strips, and your mention
would ride along with your words.

## Licence

MIT.
