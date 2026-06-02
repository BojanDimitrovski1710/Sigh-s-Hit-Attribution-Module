/**
 * Sigh's Hit Attribution Module
 * Hooks into dnd5e attack rolls and posts flavor text explaining which AC
 * layer stopped the attack (armor, dex, shield spell, etc.).
 *
 * Requires: Foundry v13, dnd5e system v4+
 */

const MODULE_ID = "sighs-hit-attribution";

// ─────────────────────────────────────────────────────────────
// DEBUG HELPER
// Only logs when "Enable console debugging" is turned on.
// Usage: dbg("label", value1, value2, ...)
// ─────────────────────────────────────────────────────────────
function dbg(...args) {
    try {
        if (game.settings.get(MODULE_ID, "debug")) {
            console.log(`[${MODULE_ID}]`, ...args);
        }
    } catch {
        // settings not ready yet — swallow silently
    }
}

// ─────────────────────────────────────────────────────────────
// SETTINGS
// Registered on init, readable anywhere via game.settings.get()
// ─────────────────────────────────────────────────────────────
Hooks.on("init", () => {
    game.settings.register(MODULE_ID, "debug", {
        name: "Enable console debugging",
        hint: "Log detailed info to the browser console (F12) for every attack roll processed.",
        scope:  "world",
        config: true,
        type:   Boolean,
        default: false,
    });

    game.settings.register(MODULE_ID, "showRollInfo", {
        name: "Show roll vs AC line",
        hint: 'Display the "Roll X vs AC Y · stopped by: ..." line beneath the flavor text.',
        scope:  "world",
        config: true,
        type:   Boolean,
        default: true,
    });

    game.settings.register(MODULE_ID, "bgColor", {
        name: "Background color",
        hint: "Background color of the chat message.",
        scope:  "world",
        config: true,
        type:   new foundry.data.fields.ColorField({ nullable: false }),
        default: "#500000",
    });

    game.settings.register(MODULE_ID, "bgOpacity", {
        name: "Background opacity (0–1)",
        hint: "How opaque the background is. 1 = fully solid, 0 = fully transparent.",
        scope:  "world",
        config: true,
        type:   Number,
        range:  { min: 0, max: 1, step: 0.05 },
        default: 0.75,
    });

    game.settings.register(MODULE_ID, "textColor", {
        name: "Text color",
        hint: "Color of the main narrative text.",
        scope:  "world",
        config: true,
        type:   new foundry.data.fields.ColorField({ nullable: false }),
        default: "#ffffff",
    });

    game.settings.register(MODULE_ID, "subTextColor", {
        name: "Sub-text color",
        hint: 'Color of the small "Roll X vs AC Y" line.',
        scope:  "world",
        config: true,
        type:   new foundry.data.fields.ColorField({ nullable: false }),
        default: "#cccccc",
    });

    game.settings.register(MODULE_ID, "borderColor", {
        name: "Border color",
        hint: "Color of the left border stripe.",
        scope:  "world",
        config: true,
        type:   new foundry.data.fields.ColorField({ nullable: false }),
        default: "#cc0000",
    });

    game.settings.register(MODULE_ID, "iconColor", {
        name: "Icon color",
        hint: "Color of the shield icon.",
        scope:  "world",
        config: true,
        type:   new foundry.data.fields.ColorField({ nullable: false }),
        default: "#ff6b6b",
    });
});

// ─────────────────────────────────────────────────────────────
// AC FORMULA PARSER
// Handles racial natural armor formulas like:
//   "13 + @abilities.dex.mod"  → Lizardfolk, Locathah
//   "12 + @abilities.con.mod"  → Loxodon
//   "17"                       → Tortle (flat)
// Returns { base, abilityKey, mod, label, abbr } or null if unparseable.
// ─────────────────────────────────────────────────────────────
function parseACFormula(formula, actor) {
    if (!formula) return null;

    const ABILITIES = {
        str: { label: "Strength",     abbr: "STR" },
        dex: { label: "Dexterity",    abbr: "DEX" },
        con: { label: "Constitution", abbr: "CON" },
        int: { label: "Intelligence", abbr: "INT" },
        wis: { label: "Wisdom",       abbr: "WIS" },
        cha: { label: "Charisma",     abbr: "CHA" },
    };

    for (const [key, info] of Object.entries(ABILITIES)) {
        if (formula.includes(`@abilities.${key}.mod`)) {
            const stripped = formula.replace(new RegExp(`@abilities\\.${key}\\.mod`), "")
                                    .replace(/[+\s]/g, "");
            const base = parseInt(stripped);
            const mod  = actor.system.abilities[key]?.mod ?? 0;
            return { base: isNaN(base) ? 10 : base, abilityKey: key, mod, ...info };
        }
    }

    // Pure number — flat AC (e.g. Tortle's 17)
    const flat = parseInt(formula.trim());
    if (!isNaN(flat)) return { base: flat, abilityKey: null, mod: 0, label: null, abbr: null };

    return null;
}

// ─────────────────────────────────────────────────────────────
// SHIELD SPELL DETECTION
// ─────────────────────────────────────────────────────────────
function detectShieldSpellBonus(actor) {
    const AC_KEYS = [
        "system.attributes.ac.bonus",
        "system.attributes.ac.shield",
    ];
    for (const effect of actor.effects) {
        if (effect.disabled) continue;
        for (const change of effect.changes) {
            if (AC_KEYS.includes(change.key) && Number(change.value) >= 4) {
                return { bonus: Number(change.value), effectName: effect.name };
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// BARKSKIN / AC MINIMUM DETECTION
// Barkskin sets system.attributes.ac.min rather than adding a
// bonus. It only contributes AC when the natural total is below
// the minimum. We capture the min value and the effect name so
// the layer can be labelled correctly.
// ─────────────────────────────────────────────────────────────
function detectACMinimum(actor) {
    for (const effect of actor.effects) {
        if (effect.disabled) continue;
        for (const change of effect.changes) {
            if (change.key === "system.attributes.ac.min") {
                return { min: Number(change.value), effectName: effect.name };
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// AC LAYER BUILDER
// ─────────────────────────────────────────────────────────────
function buildACLayers(actor) {
    const ac     = actor.system.attributes.ac;
    const dexMod = actor.system.abilities.dex.mod;
    const calc   = ac.calc ?? "default";

    // ── Debug: dump every active effect touching AC ───────────
    const AC_RELATED = /attributes\.ac/;
    const acEffects = [];
    for (const effect of actor.effects) {
        const relevantChanges = effect.changes.filter(c => AC_RELATED.test(c.key));
        if (relevantChanges.length > 0) {
            acEffects.push({
                name:     effect.name,
                disabled: effect.disabled,
                changes:  relevantChanges.map(c => `${c.key} ${c.mode === 2 ? "+=" : "="} ${c.value}`),
            });
        }
    }
    dbg(
        "AC effects on", actor.name,
        `| total AC: ${ac.value} | calc: ${calc} | dex mod: ${dexMod}`,
        "\nEffects:", acEffects.length ? acEffects : "(none)",
        "\nEquipped armor:", actor.items.filter(i => i.type === "equipment" && i.system.equipped && i.system.type?.value).map(i => `${i.name} (${i.system.type.value}, AC ${i.system.armor?.value})`),
    );

    const equippedArmor = actor.items.find(i =>
        i.type === "equipment" &&
        i.system.equipped &&
        ["light", "medium", "heavy"].includes(i.system.type?.value)
    );
    const equippedShieldItem = actor.items.find(i =>
        i.type === "equipment" &&
        i.system.equipped &&
        i.system.type?.value === "shield"
    );

    const shieldSpell = detectShieldSpellBonus(actor);
    const acMinimum   = detectACMinimum(actor);

    const layers = [];
    let cursor = 0;

    // Zone 0: below base 10 — complete fumble
    layers.push({ floor: -Infinity, ceil: 10, key: "fumble" });
    cursor = 10;

    // Determine armor base and dex cap
    let armorBase     = 10;
    let dexCap        = Infinity;
    let armorName     = null;
    let secondaryStat = null; // { mod, label } — used by unarmored defense variants

    if (calc === "mage") {
        armorBase = 13;
        armorName = "Mage Armor";
    } else if (calc === "draconic") {
        // Draconic Resilience (Sorcerer) and Dragon Hide (feat): AC = 13 + Dex
        armorBase = 13;
        armorName = "Draconic Resilience";
    } else if (calc === "unarmoredBarb") {
        // Barbarian Unarmored Defense: AC = 10 + Dex + Con
        const conMod = actor.system.abilities.con.mod;
        if (conMod > 0) secondaryStat = { mod: conMod, label: "Constitution", abbr: "CON" };
    } else if (calc === "unarmoredMonk") {
        // Monk Unarmored Defense: AC = 10 + Dex + Wis
        const wisMod = actor.system.abilities.wis.mod;
        if (wisMod > 0) secondaryStat = { mod: wisMod, label: "Wisdom", abbr: "WIS" };
    } else if (calc === "natural" || calc === "custom") {
        // Try to parse the formula first — covers racial natural armor and any
        // custom formula that follows the "<base> + @abilities.<key>.mod" pattern.
        const parsed = parseACFormula(ac.formula, actor);
        dbg("Natural/custom AC formula:", ac.formula, "→ parsed:", parsed);

        if (parsed) {
            armorBase = parsed.base;
            armorName = calc === "natural" ? "natural armor" : "natural armor";

            if (parsed.abilityKey === "dex") {
                // e.g. Lizardfolk / Locathah: 13 + Dex — let the dex layer handle it
                dexCap = Infinity;
            } else if (parsed.abilityKey) {
                // e.g. Loxodon: 12 + Con — treat like barbarian secondary stat
                dexCap = 0;
                if (parsed.mod > 0) {
                    secondaryStat = { mod: parsed.mod, label: parsed.label, abbr: parsed.abbr, source: "natural" };
                }
            } else {
                // e.g. Tortle: flat 17 — no ability mod at all
                dexCap = 0;
            }
        } else {
            // No formula — fall back to reading ac.armor as the flat total
            armorBase = ac.armor ?? 10;
            dexCap    = 0;
            armorName = "natural armor";
        }
    } else if (calc === "flat") {
        armorBase = ac.flat ?? 10;
        dexCap    = 0;
        armorName = "armor";
    } else if (equippedArmor) {
        armorBase = equippedArmor.system.armor.value ?? 10;
        armorName = equippedArmor.name;
        const type = equippedArmor.system.type?.value;
        if (type === "heavy")       dexCap = 0;
        else if (type === "medium") dexCap = 2;
    } else {
        armorBase = 10; // unarmored — dex goes on base directly
    }

    // Armor layer
    if (armorBase > cursor) {
        layers.push({ floor: cursor, ceil: armorBase, key: "armor", armorName });
        cursor = armorBase;
    }

    // Dex layer
    const appliedDex = Math.max(0, Math.min(dexMod, dexCap));
    if (appliedDex > 0) {
        layers.push({ floor: cursor, ceil: cursor + appliedDex, key: "dex", dexMod: appliedDex });
        cursor += appliedDex;
    }

    // Secondary stat layer (Barbarian CON, Monk WIS)
    if (secondaryStat?.mod > 0) {
        layers.push({ floor: cursor, ceil: cursor + secondaryStat.mod, key: "secondary-stat", ...secondaryStat });
        cursor += secondaryStat.mod;
    }

    // Shield item layer
    if (equippedShieldItem) {
        const bonus = equippedShieldItem.system.armor.value ?? 2;
        layers.push({ floor: cursor, ceil: cursor + bonus, key: "shield-item", shieldName: equippedShieldItem.name, bonus });
        cursor += bonus;
    }

    // Shield spell layer
    if (shieldSpell) {
        layers.push({ floor: cursor, ceil: cursor + shieldSpell.bonus, key: "shield-spell", spellName: shieldSpell.effectName, bonus: shieldSpell.bonus });
        cursor += shieldSpell.bonus;
    }

    // Barkskin / AC minimum layer
    // Only adds a layer if the minimum is actually higher than what
    // the normal layers already built up to — i.e. it's doing work.
    if (acMinimum && acMinimum.min > cursor) {
        const contribution = Math.min(acMinimum.min, ac.value) - cursor;
        layers.push({ floor: cursor, ceil: cursor + contribution, key: "barkskin", spellName: acMinimum.effectName, min: acMinimum.min });
        cursor += contribution;
    }

    // Catch-all for remaining bonuses (cover, other AEs, etc.)
    const remaining = ac.value - cursor;
    if (remaining > 0) {
        layers.push({ floor: cursor, ceil: ac.value, key: "other", bonus: remaining });
    }

    return layers;
}

// ─────────────────────────────────────────────────────────────
// LAYER LOOKUP
// ─────────────────────────────────────────────────────────────
function findMissLayer(rollTotal, layers) {
    for (let i = layers.length - 1; i >= 0; i--) {
        if (rollTotal >= layers[i].floor) return layers[i];
    }
    return layers[0];
}

// ─────────────────────────────────────────────────────────────
// FLAVOR TEXT
// ─────────────────────────────────────────────────────────────
function buildFlavorHTML(rollTotal, attackerName, defenderName, layer, defenderActor) {
    const dexMod = defenderActor.system.abilities.dex.mod;
    let narrative = "";

    switch (layer.key) {
        case "fumble":
            narrative = `<b>${attackerName}</b> completely fumbles — the attack never had a chance.`;
            break;
        case "armor":
            if (layer.armorName === "Draconic Resilience") {
                narrative = `The blow glances off <b>${defenderName}</b>'s hardened draconic scales.`;
            } else if (layer.armorName === "natural armor") {
                narrative = `The attack strikes <b>${defenderName}</b>'s natural hide — tough enough to turn the blow aside.`;
            } else {
                narrative = `The blow lands, but <b>${defenderName}</b>'s <b>${layer.armorName}</b> bears the brunt of the blow.`;
            }
            break;
        case "dex":
            narrative = `<b>${defenderName}</b> shifts just enough at the last moment — their reflexes (DEX +${dexMod}) pull them clear.`;
            break;
        case "secondary-stat":
            if (layer.source === "natural") {
                // Racial natural armor with a secondary ability (e.g. Loxodon: 12 + Con)
                narrative = `The blow strikes <b>${defenderName}</b>'s hide, but their thick natural armor absorbs what remains.`;
            } else if (layer.abbr === "CON") {
                // Barbarian unarmored defense
                narrative = `<b>${defenderName}</b>'s battle-hardened body absorbs the impact — their constitution holds firm.`;
            } else {
                // Monk unarmored defense
                narrative = `<b>${defenderName}</b> flows with preternatural calm, their focused mind sensing the strike just in time.`;
            }
            break;
        case "shield-item":
            narrative = `<b>${defenderName}</b> raises their <b>${layer.shieldName}</b> and the attack glances off with a clang.`;
            break;
        case "shield-spell":
            narrative = `An invisible barrier flares around <b>${defenderName}</b> — <b>${layer.spellName}</b> swallows the blow entirely.`;
            break;
        case "barkskin":
            narrative = `The attack scrapes across <b>${defenderName}</b>'s bark-hardened skin yet fails to pierce enough to do any significant damage.`;
            break;
        case "other":
            narrative = `<b>${defenderName}</b> is shielded by unseen protections. The attack falls just short.`;
            break;
        default:
            narrative = `<b>${defenderName}</b> narrowly avoids the attack.`;
    }

    // Read settings
    const showRollInfo = game.settings.get(MODULE_ID, "showRollInfo");
    const bgColor      = game.settings.get(MODULE_ID, "bgColor");
    const bgOpacity    = game.settings.get(MODULE_ID, "bgOpacity");
    const textColor    = game.settings.get(MODULE_ID, "textColor");
    const subTextColor = game.settings.get(MODULE_ID, "subTextColor");
    const borderColor  = game.settings.get(MODULE_ID, "borderColor");
    const iconColor    = game.settings.get(MODULE_ID, "iconColor");

    // Convert hex color + opacity into rgba for the background
    // ColorField returns a Foundry Color object, so coerce to string first
    const hex = String(bgColor).replace("#", "");
    const r   = parseInt(hex.substring(0, 2), 16);
    const g   = parseInt(hex.substring(2, 4), 16);
    const b   = parseInt(hex.substring(4, 6), 16);
    const bg  = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;

    const layerLabel = layer.armorName ?? layer.shieldName ?? layer.spellName ?? layer.key;

    const rollLine = showRollInfo ? `
        <div style="font-size:0.8em; color:${subTextColor}; margin-top:3px; font-style:normal;">
            Roll <b>${rollTotal}</b> vs AC <b>${defenderActor.system.attributes.ac.value}</b>
            &nbsp;·&nbsp; stopped by: <i>${layerLabel}</i>
        </div>` : "";

    return `
<div style="
    border-left: 3px solid ${borderColor};
    padding: 6px 10px;
    margin: 4px 0;
    font-style: italic;
    color: ${textColor};
    background: ${bg};
    border-radius: 0 4px 4px 0;
">
    <i class="fas fa-shield-halved" style="color:${iconColor}; margin-right:5px;"></i>${narrative}${rollLine}
</div>`.trim();
}

// ─────────────────────────────────────────────────────────────
// MAIN HOOK
// ─────────────────────────────────────────────────────────────
Hooks.on("dnd5e.rollAttackV2", async (rolls, options) => {
    const roll = rolls?.[0];
    dbg("Hook fired", { roll, options });

    if (!roll) {
        dbg("No roll found — exiting");
        return;
    }

    const rollTotal    = roll.total;
    const attackerName = options?.subject?.actor?.name ?? game.user?.character?.name ?? "The attacker";
    dbg("Roll total:", rollTotal, "| Attacker:", attackerName);

    const targets = game.user.targets;
    dbg("Targets:", targets?.size ?? 0, [...(targets ?? [])].map(t => t.name));

    if (!targets || targets.size === 0) {
        dbg("No targets — exiting");
        return;
    }

    for (const targetToken of targets) {
        const targetActor = targetToken.actor;
        if (!targetActor) {
            dbg("Target token has no actor — skipping:", targetToken.name);
            continue;
        }

        const defenderName = targetToken.name ?? targetActor.name;
        const totalAC      = targetActor.system.attributes.ac?.value;
        dbg("Defender:", defenderName, "| Total AC:", totalAC);

        if (totalAC == null) {
            dbg("Could not read AC — skipping");
            continue;
        }

        if (rollTotal >= totalAC) {
            dbg("Hit (roll >= AC) — no flavor message");
            continue;
        }

        const layers    = buildACLayers(targetActor);
        dbg("AC layers built:", layers.map(l => `${l.key} [${l.floor === -Infinity ? "-∞" : l.floor}–${l.ceil})`));

        const missLayer = findMissLayer(rollTotal, layers);
        dbg("Miss layer resolved:", missLayer.key, missLayer);

        const content = buildFlavorHTML(rollTotal, attackerName, defenderName, missLayer, targetActor);
        dbg("Sending chat message");

        await ChatMessage.create({
            content,
            speaker: { alias: "⚔️ Combat" },
            flags: {
                [MODULE_ID]: {
                    type:     "miss-attribution",
                    roll:     rollTotal,
                    ac:       totalAC,
                    layerKey: missLayer.key,
                }
            }
        });

        dbg("Chat message sent successfully");
    }
});

console.log(`${MODULE_ID} | loaded`);
