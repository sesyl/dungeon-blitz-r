/**
 * Which enemies a Legends' Inn stage is populated with.
 *
 * Legends' Inn is the Dread tour: every stage is a shipped dungeon kept whole, but
 * the things standing in it are replaced. The rule the dungeon is built around is
 * a single one - **every hostile is a Rogue, a Paladin or a Mage, and every one of
 * them is the Dread (`*Hard`) variant of its EntType.**
 *
 * "Rogue/Paladin/Mage" is not a naming convention here, it is the entity's body:
 * an EntType whose `parent` chain reaches `RogueBase`, `PaladinBase` or `MageBase`
 * is drawn on the player skeleton out of `Gfx_<Class>_1.swf`, which every client
 * has loaded in every level. That is what makes the swap safe in nine different
 * region SWFs - nothing has to be imported, because the art was already there.
 *
 * A level SWF names its hostiles by binding an empty marker sprite to a class
 * called `ac_<EntName>`; the client reads the EntType straight off that name. So
 * swapping an enemy is a *string* edit - see `renameAbcStrings` - and everything
 * else about the level (rooms, waves, room directors, boss cutscenes, spawn
 * counts, patrol paths) is untouched. This module decides those strings.
 *
 * Selection is deterministic: same EntTypes in, same roster out, so a rebuild
 * never silently reshuffles a dungeon that players have already learned.
 */
import * as fs from "fs";
import * as path from "path";
import { SwfLevelError } from "./swfLevelUtils";

export type MobClass = "Rogue" | "Paladin" | "Mage";
export type MobRank = "Minion" | "Lieutenant" | "MiniBoss" | "Boss";

export interface PoolEntry {
  /** The Dread EntType, i.e. what actually fights and what the server is told about. */
  entName: string;
  /**
   * The same EntType without `Hard`, which is the name that goes in the SWF.
   *
   * A Dread level does not carry Dread cue classes. `Level.as` appends `"Hard"` to
   * a cue's entType itself whenever the map's alterParams are `"Hard"`, which is
   * how every shipped Dread dungeon reuses the normal dungeon's SWF unchanged.
   * Writing `ac_<X>Hard` into the SWF therefore asks the client for `<X>HardHard`,
   * which exists for nothing - and a Legends' Inn stage came up completely empty.
   */
  baseEntName: string;
  mobClass: MobClass;
  rank: MobRank;
  /** The EntType's authored level, which is what sizes it in a Dread run. */
  level: number;
  displayName: string;
}

const RANKS: MobRank[] = ["Minion", "Lieutenant", "MiniBoss", "Boss"];

/**
 * Cue classes that name scenery rather than a creature.
 *
 * Every one of these is placed like an enemy and has an EntType with an EntRank,
 * but it is a chest, a fire trap, a spawner spire or a disguised prop that room
 * scripts drive by name. Renaming one either breaks the room or drops a Rogue
 * into a torch bracket, so they keep the identity the level authored.
 *
 * Wisps are *not* on this list even though they float and glow: they are real
 * hostiles with a rank and a health pool, and groundAirborneCues puts their
 * replacement somewhere it can stand.
 */
const PROP_CUES = /^(TreasureChest|Vigil|CaveVigil|EmberBush|DoorPortal|NephitSpireMarker|DesertMimicSpire|Mimic$)/;

/**
 * Where a slot may look when its own rank is empty.
 *
 * A boss slot only ever takes a boss: a boss room's script, its health bar and
 * its ending cutscene are all authored against something that fights like one.
 * The other three may borrow from a neighbour, because the Rogue side of the
 * roster is thin at Minion rank (the game only ever shipped three) and a run of
 * nine dungeons would otherwise repeat the same three lizards all night.
 */
const RANK_FALLBACKS: Record<MobRank, MobRank[]> = {
  Minion: ["Minion", "Lieutenant"],
  Lieutenant: ["Lieutenant", "MiniBoss", "Minion"],
  MiniBoss: ["MiniBoss", "Lieutenant"],
  Boss: ["Boss"],
};

function readEntTypes(dataDir: string): Map<string, Record<string, string>> {
  const raw = fs.readFileSync(path.join(dataDir, "EntTypes.json"), "utf8").replace(/^﻿/, "");
  const parsed = JSON.parse(raw) as { EntTypes: { EntType: Array<Record<string, string>> } };
  const byName = new Map<string, Record<string, string>>();
  for (const ent of parsed.EntTypes.EntType) {
    const name = String(ent.EntName ?? "");
    if (name) byName.set(name, ent);
  }
  return byName;
}

/** Walks `parent` until it hits one of the three player bases, or runs out. */
function mobClassOf(byName: Map<string, Record<string, string>>, entName: string): MobClass | null {
  let current = byName.get(entName);
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current.EntName === "RogueBase") return "Rogue";
    if (current.EntName === "PaladinBase") return "Paladin";
    if (current.EntName === "MageBase") return "Mage";
    const parent = String(current.parent ?? "");
    if (!parent) return null;
    current = byName.get(parent);
  }
  return null;
}

/** Reads a field through the `parent` chain, the way the client resolves one. */
function inheritedField(byName: Map<string, Record<string, string>>, entName: string, field: string): string {
  let current = byName.get(entName);
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current[field] !== undefined) return String(current[field]);
    current = byName.get(String(current.parent ?? ""));
  }
  return "";
}

function rankOf(ent: Record<string, string> | undefined): MobRank | null {
  const rank = String(ent?.EntRank ?? "");
  return (RANKS as string[]).includes(rank) ? (rank as MobRank) : null;
}

/**
 * Every Dread Rogue/Paladin/Mage the game has.
 *
 * Excluded by name: summoned clones and pets (they belong to a power, not a
 * room), the two `*Marker` stand-ins a boss encounter spawns itself, the Home
 * training dummies, and the Spy set, whose EntTypes carry no display name and
 * exist only for one scripted Shazari scene.
 *
 * Also excluded: any `XHard` with no plain `X`. The SWF can only name the base
 * (see `baseEntName`), so a Dread EntType whose base was never authored - the
 * game has a few, `ShadeInquisitor2Hard` among them - is unreachable however
 * good a fit it looks.
 */
export function loadDreadClassMobPool(dataDir: string): PoolEntry[] {
  const byName = readEntTypes(dataDir);
  const pool: PoolEntry[] = [];

  for (const ent of byName.values()) {
    const entName = String(ent.EntName ?? "");
    if (!/Hard$/.test(entName)) continue;
    if (/Marker|Dummy|Clone|ShadowLegion|GreenKnight|Emperor|^Spy/.test(entName)) continue;

    const baseEntName = entName.slice(0, -4);
    if (!byName.has(baseEntName)) continue;

    const mobClass = mobClassOf(byName, entName);
    const rank = rankOf(ent);
    if (!mobClass || !rank) continue;

    pool.push({
      entName,
      baseEntName,
      mobClass,
      rank,
      level: Math.max(1, Math.round(Number(ent.Level ?? 0)) || 1),
      // Through the parent chain: the name a boss fights under is the one the
      // client would show, and a few EntTypes inherit theirs rather than declare it.
      displayName: inheritedField(byName, entName, "DisplayName"),
    });
  }

  pool.sort((left, right) => left.entName.localeCompare(right.entName));
  if (pool.length === 0) throw new SwfLevelError("EntTypes.json has no Dread Rogue/Paladin/Mage entries");
  return pool;
}

/** The elements the dungeon entry screen shows, most common first. */
const ELEMENT_ORDER = ["Fire", "Ice", "Air", "Earth", "Life", "Death"];
const KINGDOM_TO_ELEMENT: Record<string, string> = {
  Draconic: "Fire",
  Infernal: "Air",
  Mythic: "Ice",
  Sylvan: "Life",
  Trog: "Earth",
  Undead: "Death",
};

function normalizeElement(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return ELEMENT_ORDER.includes(normalized) ? normalized : "";
}

/**
 * The elements a roster reads as, ranked the way generate-dungeon-enemy-elements.js
 * ranks them: by how many of the level's enemies carry each, ties broken by the
 * screen's own element order. An EntType with no `Element` falls back to its
 * Kingdom, which is where most of these humanoids get theirs.
 */
export function resolveRosterElements(dataDir: string, entNames: Iterable<string>): string[] {
  const byName = readEntTypes(dataDir);
  const counts = new Map<string, number>();

  for (const entName of entNames) {
    const ent = byName.get(entName);
    const element = normalizeElement(ent?.Element) || normalizeElement(KINGDOM_TO_ELEMENT[String(ent?.Kingdom ?? "")]);
    if (!element) continue;
    counts.set(element, (counts.get(element) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) =>
      right[1] !== left[1] ? right[1] - left[1] : ELEMENT_ORDER.indexOf(left[0]) - ELEMENT_ORDER.indexOf(right[0]),
    )
    .map(([element]) => element);
}

export interface EnemyCue {
  /** The `ac_` class as the level SWF exports it. */
  className: string;
  /** The EntType it names, i.e. the class without the `ac_` prefix. */
  entName: string;
  rank: MobRank;
  /**
   * Whether the cue was authored for something airborne. Those placements sit
   * over chasms and water deliberately, so their replacement has to fly too.
   */
  flying: boolean;
}


/** The hostiles a stage places, in the order the SWF exports them. */
export function readEnemyCues(dataDir: string, classNames: string[]): EnemyCue[] {
  const byName = readEntTypes(dataDir);
  const cues: EnemyCue[] = [];

  for (const className of classNames) {
    if (!className.startsWith("ac_")) continue;
    const entName = className.slice(3);
    if (PROP_CUES.test(entName)) continue;

    const ent = byName.get(entName);
    const rank = rankOf(ent);
    // No EntType, or an EntType with no rank, means the cue is not a creature the
    // client will build a hostile out of - a door target, a group anchor, an
    // effect. Those are left alone for the same reason the props above are.
    if (!ent || !rank) continue;
    cues.push({ className, entName, rank, flying: /true/i.test(inheritedField(byName, entName, "Flying")) });
  }

  return cues;
}

export interface StageEnemyPlan {
  /** Cycled across the stage's hostiles, so a weight repeated twice is twice as common. */
  classWeights: MobClass[];
  /** The Dread tier the stage should land on, as an EntType level band. */
  levelBand: { min: number; max: number };
  /** What the stage's boss fights as. */
  bossClass: MobClass;
}

export interface AssignmentContext {
  /** EntTypes already handed out in earlier stages, so the tour keeps introducing new faces. */
  usedGlobally: Set<string>;
}

export function createAssignmentContext(): AssignmentContext {
  return { usedGlobally: new Set<string>() };
}

/**
 * Scores how well a pool entry fits a slot; lowest wins, name breaks ties.
 *
 * The weights encode the brief, in order of how much they matter:
 *   - never reuse an EntType inside one stage (a stage with two rooms of the same
 *     bandit reads as a bug, and the level already varies its own cues);
 *   - stay in the class the stage is leaning on;
 *   - stay in the slot's rank family, so a minion wave stays a minion wave;
 *   - sit inside the stage's level band, because a Dread hostile is sized from
 *     its authored level plus the level's jump - a level-3 skeleton in the last
 *     dungeon would be free experience;
 *   - and, all else equal, prefer a face the tour has not used yet.
 */
function scoreCandidate(
  entry: PoolEntry,
  desiredClass: MobClass,
  desiredRank: MobRank,
  plan: StageEnemyPlan,
  context: AssignmentContext,
  usedInStage: Set<string>,
  reservedBaseNames: Set<string>,
): number {
  if (usedInStage.has(entry.entName)) return Number.POSITIVE_INFINITY;
  // A name the stage already exports cannot be a rename target: the ABC pool
  // would hold it twice, and renameAbcStrings refuses that outright rather than
  // let two classes answer to one name.
  if (reservedBaseNames.has(entry.baseEntName)) return Number.POSITIVE_INFINITY;

  const allowedRanks = RANK_FALLBACKS[desiredRank];
  const rankIndex = allowedRanks.indexOf(entry.rank);
  if (rankIndex === -1) return Number.POSITIVE_INFINITY;

  const bandMiss =
    entry.level < plan.levelBand.min
      ? plan.levelBand.min - entry.level
      : entry.level > plan.levelBand.max
        ? entry.level - plan.levelBand.max
        : 0;

  return (
    (entry.mobClass === desiredClass ? 0 : 400) +
    rankIndex * 120 +
    bandMiss * 6 +
    (context.usedGlobally.has(entry.entName) ? 90 : 0)
  );
}

function pick(
  pool: PoolEntry[],
  desiredClass: MobClass,
  desiredRank: MobRank,
  plan: StageEnemyPlan,
  context: AssignmentContext,
  usedInStage: Set<string>,
  reservedBaseNames: Set<string>,
): PoolEntry {
  let best: PoolEntry | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const entry of pool) {
    const score = scoreCandidate(entry, desiredClass, desiredRank, plan, context, usedInStage, reservedBaseNames);
    if (score < bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  if (!best) throw new SwfLevelError(`no Dread ${desiredClass} ${desiredRank} left to place`);
  return best;
}

export interface EnemyAssignment {
  /**
   * `ac_<old>` -> `ac_<new base name>`, ready for the ABC string pool. The target
   * carries no `Hard`; the level's Dread mode is what adds it at runtime.
   */
  renames: Map<string, string>;
  /**
   * The roster, in placement order, for the dungeon entry screen and the diff.
   * `to` is the *Dread* name, because that is what the client reports and what
   * every server-side lookup - bosses, catalogs, elements - is keyed on.
   */
  roster: Array<{ from: string; to: string; displayName: string; mobClass: MobClass; rank: MobRank; level: number }>;
  /** What the stage's boss became, in its Dread name. The portal watches for these. */
  bosses: string[];
}

/**
 * Repopulates one stage.
 *
 * Bosses are assigned first and out of the class the stage was planned around, so
 * the fight at the end is the one the stage is named for rather than whatever the
 * weight cycle happened to land on. Everything else is walked in the SWF's own
 * export order - stable, and unrelated to how the rooms are laid out, so the
 * weights spread across the whole dungeon instead of filling room 1 with Rogues.
 */
export function assignStageEnemies(
  cues: EnemyCue[],
  plan: StageEnemyPlan,
  pool: PoolEntry[],
  context: AssignmentContext,
  /** Every `ac_` name the stage already exports, so a rename cannot collide. */
  reservedBaseNames: Set<string>,
): EnemyAssignment {
  const renames = new Map<string, string>();
  const roster: EnemyAssignment["roster"] = [];
  const bosses: string[] = [];
  const usedInStage = new Set<string>();

  const take = (cue: EnemyCue, desiredClass: MobClass): void => {
    const entry = pick(pool, desiredClass, cue.rank, plan, context, usedInStage, reservedBaseNames);
    usedInStage.add(entry.entName);
    context.usedGlobally.add(entry.entName);
    renames.set(cue.className, `ac_${entry.baseEntName}`);
    roster.push({
      from: cue.entName,
      to: entry.entName,
      displayName: entry.displayName,
      mobClass: entry.mobClass,
      rank: entry.rank,
      level: entry.level,
    });
    if (cue.rank === "Boss") bosses.push(entry.entName);
  };

  for (const cue of cues) {
    if (cue.rank === "Boss") take(cue, plan.bossClass);
  }

  let weightIndex = 0;
  for (const cue of cues) {
    if (cue.rank === "Boss") continue;
    take(cue, plan.classWeights[weightIndex % plan.classWeights.length]);
    weightIndex += 1;
  }

  return { renames, roster, bosses };
}
