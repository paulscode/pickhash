# How Pickhash works

This is a plain-language guide for anyone using Pickhash — no technical background needed.

## The idea in one paragraph

Normally, to mine Bitcoin you buy expensive machines. Pickhash lets you **rent** mining power
(called *hashrate*) by the hour from an online marketplace, and point it at **your own** Bitcoin
setup — so the machines you're renting mine *your* blocks instead of someone else's. You decide how
much to spend and for how long; Pickhash finds good rigs, rents them, aims them at your pool, and
watches over them so you get what you paid for.

Think of it like renting a crew of miners for an afternoon, where you tell them exactly which job to
work on.

## What you need before you start

- **A MiningRigRentals account** with a small amount of Bitcoin deposited (this is what pays for the
  rentals). You create an API key there and paste it into Pickhash during setup.
- **Somewhere for the hashrate to point** — a "stratum endpoint," usually your own Bitcoin node. If
  you run the companion app **HashGG**, Pickhash can find this automatically; otherwise you type it in.
- **A dashboard password**, which you set as the very first step. It protects the controls that spend
  real Bitcoin.

The setup wizard walks you through all of this once, in order.

## Two ways to rent

Once you're set up, the **Rent Hashrate** panel offers two modes:

### Autopilot (the default)
You give it a **target** amount of hashrate, a **budget** (how much Bitcoin you're willing to spend),
and a **time cap** (how long to keep going). Autopilot then quietly does the work: it rents the
cheapest reliable rigs, tops them up as they expire, and keeps you near your target — stopping the
moment either the budget or the time runs out. It fills in gradually, one rig at a time, and shows you
a live estimate of how many rigs it'll take and roughly how much you'll spend.

### Quick Rent
A one-shot rental. You work with **three linked numbers** — how much to **spend**, how much
**hashrate** you want, and for how long (**duration**). Fill in any two and Pickhash solves for the
third, then shows you an exact quote before you commit.

## Rehearse first: DRY-RUN vs LIVE

Pickhash starts in **DRY-RUN** mode, which is a rehearsal: it goes through all the motions and shows
you exactly what it *would* rent, but **spends nothing**. When you're happy, you switch to **LIVE** to
let it actually spend. Going LIVE always requires your password, and if your marketplace key is
powerful enough to move funds, it asks you to type "LIVE" to confirm — one extra deliberate step
before any real Bitcoin is spent.

## Staying in control: budget and guardrails

Every rental is checked against limits before any money moves:

- Your **budget** for the session.
- A **max session budget** and a **rolling 24-hour spend cap** (in Settings) that no session can
  exceed — a safety net in case you set something too high by accident.
- An optional **price ceiling** so it never pays more than you'd consider fair for hashrate.

Pickhash also only ever pays for what it can afford from your confirmed balance, and it never rents the
same rig twice in one cycle.

## Watching over your rentals

Renting hashrate isn't "set and forget" — rigs ramp up, occasionally under-deliver, or drop offline.
Pickhash watches each rental and shows a **health** badge with the live delivery percentage:

- **Ramping** — a fresh rig warming up (this is normal for the first few minutes).
- **Healthy** — delivering close to what was advertised.
- **Degraded / Offline** — under-delivering or not reachable; Pickhash flags it.

If a rig ends up delivering poorly, the marketplace usually **auto-refunds** the difference on its own
— Pickhash tells you this so you don't chase it unnecessarily, and only nudges you toward filing a
support ticket if that automatic refund doesn't come through. The **History** tab keeps a record of
every past session with its real cost and delivery.

## "Am I getting a good deal?" — Hash Value

The **Market** page shows a *hash value* read: what the market is currently paying to rent hashrate
versus what **you're** paying, side by side, with a clear over/under-market percentage. It's the
quick answer to "is this a good price right now?" — the same idea other hashrate marketplaces show.

## A few honest notes

- **This spends real Bitcoin.** The rehearsal (DRY-RUN) is there so you can see exactly what will
  happen before it does. Review your budget and guardrails in **Settings** before going LIVE.
- **The marketplace is a third party.** If it's briefly unreachable, Pickhash stays running and
  simply waits — nothing breaks.
- **Keep your backups safe.** Your data (including your marketplace credentials, encrypted) is included
  in your platform's backups; the real protection for those backups is your platform's own backup
  password. See the project's security notes for details.

That's the whole idea: you set the numbers, Pickhash does the shopping and the babysitting, and you get
rented hashrate pointed at your own mining — on your terms.
