# Sigh's Hit Attribution

A [Foundry VTT](https://foundryvtt.com/) module for the **dnd5e** system that
posts a short narrative chat message whenever an attack **misses**, explaining
*why*; which layer of the defender's AC actually stopped the blow (armor,
Dexterity, a shield, a spell, Barkskin, etc.).

The flavor text isn't static — it's picked at random from a pool that's aware
of the attack's **damage type**, the **actual attack name** (ammo weapons are
flavored as "arrow"/"bolt"/"bullet" instead of the weapon itself), and
whether that name is **singular or plural** (Bite vs. Claws), so the grammar
always comes out right.

Instead of a bare "Attack Roll: 14 (Miss)", players and the GM get a message
tailored to what actually stopped the hit:

> 🛡️ *The arrow finds no gap in **Orla**'s **Half Plate**, skittering off
> harmlessly.*
> Roll **11** vs AC **14** · stopped by: *Half Plate*

> 🛡️ *The Claws land squarely but **Orla**'s **Half Plate** turns them
> aside.*
> Roll **11** vs AC **14** · stopped by: *Half Plate*

> 🛡️ *Tansy shifts just enough at the last moment — their reflexes
> pulling them clear just in time.*
> Roll **15** vs AC **16** · stopped by: *dex*

> 🛡️ *An invisible barrier flares around **Elyra** as their **Shield** spell
> swallows the Fire Bolt entirely.*
> Roll **14** vs AC **21** · stopped by: *Shield*

## Features

- Hooks into every `dnd5e` attack roll and, on a miss, reconstructs the
  defender's AC as a stack of ordered "layers" (base armor → Dexterity →
  secondary ability → shield → magical bonuses → minimums → leftovers).
- Finds the exact layer the roll fell short of and generates flavor text
  tailored to that layer — different wording for armor, natural hide,
  reflexes, shields, spells, etc.
- Picks the flavor line based on the attack's **damage type** (piercing,
  slashing, fire, cold, ...), falling back to a generic pool when the damage
  type isn't covered or can't be read.
- Resolves the real **attack name** for the sentence — weapons that use
  ammunition (bows, crossbows, slings, firearms) get flavored with a natural
  noun like "arrow" or "bolt" instead of the weapon's own name.
- Automatically adjusts grammar (goes/go, is/are, was/were) depending on
  whether the resolved attack name is singular or plural (Bite vs. Claws).
- All flavor lines live in `lang/en.json` as randomized pools, so the same
  miss doesn't read the same way twice.
- Chat card styling (colors, opacity, whether the "Roll X vs AC Y" line is
  shown) is configurable per-world via module settings.

## How it works

1. The module listens for the `dnd5e.rollAttackV2` hook.
2. For each currently targeted token, it compares the roll total to the
   target's AC. If the roll meets or beats AC (a hit), nothing happens.
3. On a miss, it builds an ordered stack of AC "layers" for the defender —
   contiguous numeric ranges, each tagged with what produced it. An example
   AC of 21 (chain shirt + 2 Dex + Shield spell) breaks down like this:

   ```
   range     layer          source
   ─────     ─────          ──────
    0–10     fumble         complete whiff
   10–14     armor          Chain Shirt
   14–16     dex            Dexterity +2
   16–21     shield-spell   Shield spell (+5)
   ```
4. It walks the layers to find which one the roll total fell into (e.g. the
   "dex" or "shield-spell" band above).
5. In parallel it resolves the attack's **damage type**, works out the real
   **attack name** (substituting "arrow"/"bolt"/"bullet" for ammo weapons),
   and determines whether that name is singular or plural.
6. It looks up `lang/en.json` for `[layer][damageType]` (falling back to
   `[layer]["default"]`), picks one line from that pool at random, and fills
   in the tokens — including the singular/plural grammar helpers.
7. The result is posted as a chat message with the `⚔️ Combat` speaker alias,
   tagged with flags (`type`, `roll`, `ac`, `layerKey`) so other modules or
   macros can react to it if needed.

## Supported AC types

Built from the actor's `system.attributes.ac.calc` value:

| `calc` value         | Meaning                                                                    |
|----------------------|----------------------------------------------------------------------------|
| `flat`               | A fixed AC value with no formula                                           |
| default / armor      | Standard equipped-armor AC, dex-capped by armor type (light/medium/heavy)  |
| `mage`               | Mage Armor (13 + Dex)                                                      |
| `draconic`           | Draconic Resilience / Dragon Hide (13 + Dex)                               |
| `unarmoredBarb`      | Barbarian Unarmored Defense (10 + Dex + Con)                               |
| `unarmoredMonk`      | Monk Unarmored Defense (10 + Dex + Wis)                                    |
| `natural` / `custom` | Racial natural armor and custom formulas, or a flat number                 |

On top of the base armor layer, the module also detects and layers in:

- **Equipped shields** (`shield` type equipment items)
- **Magical AC bonuses** from active effects that modify `ac.bonus` or
  `ac.shield` (e.g. *Shield* spell +5, *Shield of Faith* +2, *Haste* +2),
  stacked largest-first
- **AC minimums** such as *Barkskin*, which only contributes a layer when it
  actually raises the total above what the other layers already provide
- Any remaining unaccounted-for bonus (cover, misc active effects, etc.) as a
  catch-all "other" layer

## Installation

1. In Foundry's **Add-on Modules** tab, click **Install Module**.
2. Paste the manifest URL for this module (or install manually by placing
   this repository's contents in `Data/modules/sighs-hit-attribution`).
3. Enable **Sigh's Hit Attribution** in your world's **Manage Modules**
   list.

### Requirements

- Foundry VTT **v13**
- The **dnd5e** system, **v4+**

## Configuration

All settings live under **Game Settings → Configure Settings → Module
Settings → Sigh's Hit Attribution** (world scope — GM only):

| Setting                     | Description                                                        | Default   |
|------------------------------|----------------------------------------------------------------------|-----------|
| Enable console debugging     | Logs detailed per-roll info (AC effects, parsed formulas, resolved layers) to the browser console (F12) | off |
| Show roll vs AC line         | Toggles the small "Roll X vs AC Y · stopped by: ..." line under the flavor text | on |
| Simple Responses mode         | Skips the random narrative flavor text; states only the attack used and which AC layer stopped it (or that it fumbled) | off |
| Background color             | Chat card background color                                          | `#500000` |
| Background opacity           | Chat card background opacity (0–1)                                  | `0.75`    |
| Text color                   | Main narrative text color                                           | `#ffffff` |
| Sub-text color                | Color of the "Roll X vs AC Y" line                                  | `#cccccc` |
| Border color                 | Color of the card's left border stripe                              | `#cc0000` |
| Icon color                   | Color of the shield icon                                             | `#ff6b6b` |

## Troubleshooting

Turn on **Enable console debugging** and open the browser console (F12). For
every processed attack roll you'll see the hook payload, the defender's AC
effects and equipped armor, the parsed AC formula (for natural/custom AC),
the full layer stack that was built, and which layer the roll resolved to.

## Compatibility notes

- Only fires on a **miss**; hits are intentionally left alone.
- Requires at least one token to be targeted when the attack is rolled —
  untargeted attacks are skipped.
- If an actor's AC can't be read (`system.attributes.ac.value` is
  `null`/`undefined`), that target is silently skipped.

## Bounty Board

- Add support for cover systems that add to AC
- Add support for magic items and effects that add to ac (ring of protection, alchemist alchemical brew)
- Add support for dynamic effects that effect hits (fighting styles, some reactions)
