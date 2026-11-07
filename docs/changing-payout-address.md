# Changing your payout address mid-campaign

This guide is for the BLAKE2b setup: **Datum Gateway (BLAKE2b)** mining for the **Convoy** pool,
exposed to the internet by **HashGG** through a **playit.gg** tunnel, with **Pickhash** renting
BLAKE2b rigs from MiningRigRentals (MRR) and pointing them at that tunnel. It explains where your
payout address lives, what order to change things in, and how to check the change took effect.
A running session does not need to be stopped.

## Where the address lives

Your payout address is stored in two places, and they do different jobs:

| Where | What it controls |
|---|---|
| **Pickhash**, Settings → Stratum endpoint → worker field | The address Convoy credits for **rented** hashrate. Every rented rig connects as `<address>.r<rental-id>`. Datum Gateway passes that username through to Convoy unchanged, and Convoy credits the address in it. |
| **Datum Gateway**, the *Set Payout Address* action | The address paid when the gateway **mines solo** because Convoy is unreachable, and the address used for any miner that connects without one. |

Pickhash also writes your address into two places on MRR. It keeps both up to date automatically:

- **The saved pool** in your MRR account (named `pickhash:blake2b:<host>:<port>`). Every new rental
  starts on this pool until its own per-rental setting is applied.
- **The per-rental pool setting** on each running rental.

HashGG and the playit.gg tunnel never see the address. They only forward the gateway's port, so
**nothing changes there**.

> **Why Datum's address matters too.** In the Datum Gateway (BLAKE2b) package, *Pooled Mining Only*
> is off by default. If Convoy becomes unreachable, the gateway keeps mining solo, and a block found
> then pays its **whole** reward to Datum's own payout address. Leave that set to an old address
> and a solo block would be paid there.

## Before you start

1. **Get the new address from your BLAKE2b wallet** and copy it rather than typing it. It must be a
   mainnet address starting with `bc1`, `1` or `3`.
2. **Check that Datum passes usernames through.** In Datum Gateway's configuration, *Pass Full
   Usernames* should be **on**, which is the default. If it is off, Convoy credits Datum's address
   for everything and the address Pickhash sends ends up at most in a worker name. In that case
   the Datum step below is the one that matters.
3. **Make sure Pickhash is in LIVE mode** if a session is running. Running rentals are only moved
   in LIVE; in DRY-RUN they stay on the old address until you switch back to LIVE.
4. **Keep the old wallet.** Convoy pays under TIDES, so shares already submitted under the old
   address stay credited to it and keep being paid in the blocks found after the switch, until they
   age out of the window. Do not discard the old wallet's keys.

## Step 1: Pickhash (no restart, no downtime)

1. Open **Settings → Stratum endpoint**.
2. Leave the host and port as they are; they are your playit.gg tunnel.
3. Replace the worker field with the new address. A bare address is enough, since Pickhash adds
   `.r<rental-id>` to it for each rental.
4. Click **Test & save endpoint**.

What happens:

- **The address is checked.** A Bitcoin address carries a checksum, and one wrong character is
  refused before anything is saved. This check matters because neither Datum nor the endpoint test
  would catch a typo: the gateway serves work for any username, so a mistyped address would test
  fine and every rental would then be credited to an address nobody holds. The check does not
  catch a valid address from the wrong network, such as a testnet `tb1…`.
- **The endpoint is tested** with the username rentals will actually send, then saved.
- **The MRR saved pool is updated** to the new address, so new rentals start under it. If MRR
  refuses that update, nothing is lost: each new rental still gets its own setting moments after it
  starts, and the refusal is logged under Decisions.
- **Within about a minute**, on the next control tick, every running rental's pool setting is
  rewritten to `<new-address>.r<rental-id>` on the saved host. Each rig reconnects once, which costs a few seconds of
  shares. Its per-rig difficulty is kept. An alert confirms it: *"Moved N active rentals to your
  new payout address …"*. If MRR refuses an update, the alert says how many are left, and Pickhash
  retries them every minute until they all move.

Between saving and the next tick, running rigs keep mining to the old address. That is still your
address, so nothing is lost.

## Step 2: Datum Gateway (one short restart)

1. In StartOS, open **Datum Gateway (BLAKE2b) → Actions → Set Payout Address** and enter the same
   new address.
2. **Restart** Datum Gateway. The new address only takes effect after a restart.

Every rig connected to the gateway drops during the restart and reconnects when it is back, usually
within a minute. The tunnel's host and port stay the same, so nothing needs re-pointing. Pickhash
only stops renting if the endpoint is down for about 2½ minutes, so a normal restart does not trip
it.

**When to restart:**

- **Best:** between sessions, or with no rentals running.
- **During a session:** avoid the 30 minutes after any rental was created. MRR may cancel and
  refund a new rental that is offline for 20 of its first 30 minutes, and a slow restart counts
  toward that. Rentals older than 30 minutes only lose the seconds they spend reconnecting.
- **Either order works.** Doing Pickhash first means the change that matters for rented hashrate
  takes effect immediately, and the gateway restart can wait for a convenient moment.

## Check it worked

- **Pickhash → Alerts:** the *Moved N active rentals to your new payout address* notice, with no
  rentals left to move.
- **Pickhash → Settings → Stratum endpoint:** *Current* shows the new address.
- **Convoy's dashboard, for the new address:** workers named `<new-address>.r<rental-id>` appear
  and submit shares within a few minutes. The old address's workers go quiet.
- **MRR → each rental → Pools:** priority 0 shows the new username.
- **Datum Gateway's dashboard**, after the restart: shows the new payout address.

## If something goes wrong

| Symptom | Cause and fix |
|---|---|
| *"That payout address fails its checksum"* | There is a typo. Copy the address again from the wallet. Nothing was saved, so the old address is still in use. |
| *"The endpoint serves work for that username, but not for the one rentals send"* | Datum or Convoy refused `<address>.r<id>`. Check the address belongs to the BLAKE2b chain and that *Pass Full Usernames* is on. Nothing was saved. |
| *"Endpoint saved, but the MRR pool/profile update failed"* | The new address is saved and running rentals still move. Pickhash retries the MRR update by itself on the next tick, then every 5 minutes while MRR keeps refusing. Autopilot rents nothing new until it succeeds. Saving again also retries it. |
| Rentals not moving | Pickhash is in DRY-RUN. Switch to LIVE. |
| Rigs offline after the Datum restart | Check the gateway is running and synced. If the playit.gg tunnel's host or port changed while the gateway was down, Pickhash moves the rentals to the new one automatically once HashGG reports it. |

## Changing the tunnel at the same time

A new **host or port** is handled the same way as a new address. Save it in Settings and, in LIVE
mode, running rentals move to it on the next tick, together with any address change in the same
save. Pickhash records which host each rental points at, so it can tell which rentals still need
moving, and it keeps retrying any that MRR refuses. You can shut the old tunnel down once the
*Moved N active rentals to your saved endpoint* notice shows nothing left to move.

## SHA256 setups

The same steps apply to an Ocean or other SHA256 setup, with one difference. When Pickhash's Ocean
fallback is on, each rental also has a priority-1 fallback pool, `<address>.fallback`, and rigs
parked there by dead-rig fallback stay on it. Those are **not** moved to the new address. They pay
the old address until the rental ends, so keep that wallet.
