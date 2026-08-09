/**
 * Builds LevelsLI.swf - the "Legends' Inn" dungeon.
 *
 * The dungeon is a tour of Ellyria: one authored room is lifted out of each of
 * the nine region level SWFs and chained together with local doors.
 *
 * LevelsLD.swf is used as the base because it is the small level-design sandbox
 * that already exports every generic level class the client looks for
 * (a_Door_*, a_DoorLocal_*, a_Target_*, a_PlayerSpawn, a_DoorMarker, the room and
 * level directors, and a set of a_Cue subclasses). Only artwork is imported from
 * the region SWFs - no foreign ABC is merged, because two DoABC tags defining the
 * same class is a load-time hazard. The classes the new level needs instead come
 * from renaming LevelsLD.swf's own unused exports in the ABC string pool:
 *
 *   a_Level_LDArena1      -> a_Level_LegendsInn
 *   a_BossTargetRed_1..9  -> a_Room_LI_01..09
 *   ac_<LD sandbox cue>   -> ac_<region enemy>   (all extend a_Cue, so the swap is type-safe)
 *
 * Each imported room keeps its scenery and its am_CollisionObject but loses its
 * authored functional children (cues, doors, spawns, directors); their recorded
 * positions are reused as known-good floor anchors for the new contents.
 *
 * Usage: npm exec ts-node scripts/build-levelsli-legends-inn.ts [--survey] [--out <path>]
 */
import * as fs from "fs";
import * as path from "path";
import {
  Bounds,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  buildSolidRectShape,
  buildPlaceObject2,
  buildSprite,
  characterBounds,
  characterTagsById,
  encodeTag,
  importCharacters,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  renameAbcStrings,
  spriteInnerTags,
  walkPlacements,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const BASE_SWF = path.join(CLIENT_CONTENT, "cam", "LevelsLD.swf");
const OUT_SWF = path.join(CLIENT_CONTENT, "cbp", "LevelsLI.swf");

const LEVEL_CLASS = "a_Level_LegendsInn";
const LEVEL_DONOR_CLASS = "a_Level_LDArena1";

/** Class names the client resolves by prefix; these never survive an import. */
const FUNCTIONAL_CLASS = /^(ac_|a_Cue|a_Door_|a_DoorLocal_|a_DoorMarker|a_Target_|a_CameraTarget|a_BossTarget|a_PlayerSpawn|a_PlayerDevSpawn|a_PlayerRespawn|a_RoomDirector|a_LevelDirector|a_Hotspot|a_Volume|a_Handle|a_Soundscape|a_Group)/;

interface RoomSpec {
  /** Region the room is borrowed from, for the build log. */
  region: string;
  swf: string;
  sourceRoom: string;
  /** Class the room is exported as in the new SWF. */
  roomClass: string;
  /** Class renamed away from LevelsLD.swf to free `roomClass`. */
  donorClass: string;
  /** ac_ classes to scatter across the room's authored cue anchors. */
  enemies: string[];
}

/**
 * One room per region, in the order the regions unlock in the campaign (their
 * level_config mapId order: Wolf's End 1-5 ... Valhaven 26-30). The player walks
 * the dungeon the same way they walked Ellyria, and it ends on a Valhaven boss.
 */
const ROOMS: RoomSpec[] = [
  {
    region: "Wolf's End",
    swf: "cbp/LevelsNR.swf",
    sourceRoom: "a_Room_GoblinCamp06",
    roomClass: "a_Room_LI_01",
    donorClass: "a_BossTargetRed_1",
    enemies: ["ac_GoblinDagger", "ac_GoblinHatchet", "ac_GoblinShamanHood"],
  },
  {
    region: "Blackrose Mire",
    swf: "cbp/LevelsSRN.swf",
    sourceRoom: "a_Room_SRNM07R08",
    roomClass: "a_Room_LI_02",
    donorClass: "a_BossTargetRed_2",
    enemies: ["ac_SwampSkeletonClub", "ac_SwampSpider"],
  },
  {
    region: "Bridgetown",
    swf: "cam/LevelsBT.swf",
    sourceRoom: "a_Room_BTM01RBanditCampBoss",
    roomClass: "a_Room_LI_03",
    donorClass: "a_BossTargetRed_3",
    enemies: ["ac_BanditTwinB"],
  },
  {
    region: "Cemetery Hill",
    swf: "cam/LevelsCH.swf",
    sourceRoom: "a_Room_CHM03RCrovnagBoss",
    roomClass: "a_Room_LI_04",
    donorClass: "a_BossTargetRed_4",
    enemies: ["ac_RedGhostServant", "ac_RedGhostKnight", "ac_RedGhostLord"],
  },
  {
    region: "Stormshard",
    swf: "cbp/LevelsOMM.swf",
    sourceRoom: "a_Room_SSM_Forge_R02",
    roomClass: "a_Room_LI_05",
    donorClass: "a_BossTargetRed_5",
    enemies: ["ac_InfusedSkeletonClub", "ac_InfusedSkeletonSorcerer"],
  },
  {
    region: "Emerald Glades",
    swf: "cam/LevelsEG.swf",
    sourceRoom: "a_Room_Refuge_R01",
    roomClass: "a_Room_LI_06",
    donorClass: "a_BossTargetRed_6",
    enemies: ["ac_GladeSpider", "ac_DesolateDevourer"],
  },
  {
    region: "Deepgard Castle",
    swf: "cbp/LevelsAC.swf",
    sourceRoom: "a_Room_Throne_R04",
    roomClass: "a_Room_LI_07",
    donorClass: "a_BossTargetRed_7",
    enemies: ["ac_CastleLizard1", "ac_DreadPaladin"],
  },
  {
    region: "Shazari Desert",
    swf: "cam/LevelsSD.swf",
    sourceRoom: "a_Room_SDMission06",
    roomClass: "a_Room_LI_08",
    donorClass: "a_BossTargetRed_8",
    enemies: ["ac_ImpTrickster", "ac_PuckShadow"],
  },
  {
    region: "Valhaven",
    swf: "cbp/LevelsJC.swf",
    sourceRoom: "a_Room_JCMini1_01",
    roomClass: "a_Room_LI_09",
    donorClass: "a_BossTargetRed_9",
    enemies: ["ac_ShadeWarrior", "ac_BoneFiend", "ac_ImperialMagi"],
  },
];

const BOSS_CUE_CLASS = "ac_DragonTemple";
/** Instance name a_RoomDirector_BasicBoss keys the encounter off. */
const BOSS_INSTANCE = "am_Boss";

/**
 * LevelsLD.swf sandbox cues renamed into the enemies this dungeon uses. Every
 * entry on both sides extends a_Cue, and every right-hand name is a real EntType.
 */
const CUE_RENAMES: Array<[string, string]> = [
  ["ac_BoneGolem", "ac_GoblinDagger"],
  ["ac_DreamPortalDoor", "ac_GoblinHatchet"],
  ["ac_LeapingSpider2", "ac_GoblinShamanHood"],
  ["ac_EmitterProjectile", "ac_SwampSkeletonClub"],
  ["ac_EmitterProjectile50", "ac_SwampSpider"],
  ["ac_TreasureChestEmpty", "ac_RedGhostServant"],
  ["ac_SkeletonLifebane", "ac_RedGhostKnight"],
  ["ac_SkeletonDervish", "ac_RedGhostLord"],
  ["ac_FireBomb2", "ac_InfusedSkeletonClub"],
  ["ac_DeathKnight", "ac_InfusedSkeletonSorcerer"],
  ["ac_TunnelPortal", "ac_GladeSpider"],
  ["ac_GreenKnightFalse", "ac_DesolateDevourer"],
  ["ac_TauntingSkull2", "ac_BanditTwinB"],
  ["ac_NephitSpireMarker", "ac_ImpTrickster"],
  ["ac_TauntingSkull", "ac_PuckShadow"],
  ["ac_DemonReaver", "ac_ShadeWarrior"],
  ["ac_SkeletonScourge", "ac_ImperialMagi"],
  ["ac_ShadeInquisitor", "ac_CastleLizard1"],
  ["ac_LeapingSpider", "ac_DreadPaladin"],
  ["ac_GreenKnight", BOSS_CUE_CLASS],
  // ac_BoneFiend already carries the name this dungeon wants.
];

/** Local-door letters that exist as both a_DoorLocal_X and a_Target_X in LevelsLD.swf. */
const LINK_LETTERS = ["A", "D", "F", "G", "H", "I", "K", "N"];

/** The portal drawn on every room-to-room link, borrowed from Bridgetown. */
const PORTAL_SWF = "cam/LevelsBT.swf";
const PORTAL_SOURCE_CLASS = "a_Animation_Portal";
/** Must start with "a_Animation" or Level.as will not draw it. */
const PORTAL_ART_CLASS = "a_Animation_LIPortal";
const PORTAL_ART_DONOR = "a_BossTargetRed_10";
/** Stretches the 121x203 door marker over the 304x283 portal it sits on. */
const LINK_MARKER_SCALE = 2;

/**
 * Rooms are butted up against each other. Authored dungeons (a_Level_JCMini1 for
 * instance) have no backdrop layer at all and get away with it purely because
 * their rooms tile; leaving gaps here let the camera see past the artwork, which
 * Flash renders as smeared garbage.
 */
const ROOM_GAP = 0;

/** Backdrop colour and how far it extends past the rooms, in pixels. */
const BACKDROP_RGB = 0x121722;
const BACKDROP_MARGIN = 1500;

/**
 * The borrowed rooms carry up to 31 authored cue anchors each, which would make
 * a 150-enemy dungeon. Thin them out to a normal room's worth.
 */
const MAX_ENEMIES_PER_ROOM = 6;

interface Anchor {
  x: number;
  y: number;
  enemy: boolean;
}

interface FloorBand {
  yMin: number;
  yMax: number;
}

function parseArgs(argv: string[]): { survey: boolean; out: string } {
  let survey = false;
  let out = OUT_SWF;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--survey") survey = true;
    else if (arg === "--out") out = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec ts-node scripts/build-levelsli-legends-inn.ts [--survey] [--out <path>]");
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  return { survey, out };
}

function nextFreeDepth(spriteTag: SwfTag): number {
  let max = 0;
  for (const inner of spriteInnerTags(spriteTag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.depth > max) max = place.depth;
  }
  return max + 1;
}

/**
 * Positions of the room's authored functional children, in room-local pixels.
 * Everything the game placed there stands on a floor, which makes these the
 * safest anchors available for the replacement contents.
 */
function readAnchors(swf: ReturnType<typeof readSwfFile>, roomId: number): Anchor[] {
  const nameById = new Map(readSymbolClasses(swf).map((entry) => [entry.id, entry.name]));
  const anchors: Anchor[] = [];
  walkPlacements(swf, roomId, ({ charId, name, x, y }) => {
    const className = nameById.get(charId) ?? "";
    if (/^ac_/.test(className)) {
      anchors.push({ x, y, enemy: true });
      return false;
    }
    if (FUNCTIONAL_CLASS.test(className)) {
      anchors.push({ x, y, enemy: false });
      return false;
    }
    // Cues are often nested inside unnamed wave-group sprites.
    return className === "" && name !== null;
  });
  return anchors;
}

/**
 * Vertical span of the room's am_CollisionObject, in room-local pixels. Walkable
 * ground only exists inside this band, which is what separates a real floor
 * anchor from a marker the artist parked off to one side.
 */
function readFloorBand(swf: ReturnType<typeof readSwfFile>, roomId: number): FloorBand | null {
  const byId = characterTagsById(swf);
  const roomTag = byId.get(roomId);
  if (!roomTag) return null;
  for (const inner of spriteInnerTags(roomTag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.name !== "am_CollisionObject" || place.charId === null) continue;
    const bounds = characterBounds(swf, place.charId);
    if (!bounds) return null;
    const offset = place.matrix ? place.matrix.translateY / 20 : 0;
    return { yMin: bounds.yMin / 20 + offset, yMax: bounds.yMax / 20 + offset };
  }
  return null;
}

const ELEMENT_ORDER = ["Fire", "Ice", "Air", "Earth", "Light", "Dark"];
const ENEMY_ELEMENTS_PATH = path.resolve(__dirname, "..", "data", "dungeon_enemy_elements.json");
const DOOR_SPAWN_PATH = path.resolve(__dirname, "..", "data", "door_spawn_map.json");
const ENT_TYPES_PATH = path.resolve(__dirname, "..", "data", "EntTypes.json");
const LEVEL_ID = "LegendsInn";

/**
 * dungeon_enemy_elements.json is the catalog the dungeon entry screen reads and
 * the authored-boss regression test checks against. The usual generator works
 * from decompiled room scripts, which these rooms deliberately do not have, so
 * the build writes the entry from what it actually placed.
 */
/** EntTypes.json ships with a UTF-8 BOM, which JSON.parse rejects. */
function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
}

function writeEnemyManifest(counts: Map<string, number>, rooms: string[]): void {
  const entTypes: Array<Record<string, unknown>> = readJson(ENT_TYPES_PATH).EntTypes.EntType;
  const byName = new Map(entTypes.map((entry) => [String(entry.EntName ?? ""), entry]));

  const elementCounts = new Map<string, number>();
  for (const [enemyType, count] of counts) {
    const raw = String(byName.get(enemyType)?.Element ?? "").trim();
    const element = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
    if (!ELEMENT_ORDER.includes(element)) continue;
    elementCounts.set(element, (elementCounts.get(element) ?? 0) + count);
  }

  const manifest = readJson(ENEMY_ELEMENTS_PATH);
  manifest[LEVEL_ID] = {
    elements: [...elementCounts.entries()]
      .sort((left, right) => right[1] - left[1] || ELEMENT_ORDER.indexOf(left[0]) - ELEMENT_ORDER.indexOf(right[0]))
      .map(([element]) => element),
    enemyTypes: [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([enemyType, count]) => ({ enemyType, count })),
    source: "level-swf",
    rooms,
  };
  const crlf = fs.readFileSync(ENEMY_ELEMENTS_PATH, "utf8").includes("\r\n");
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(ENEMY_ELEMENTS_PATH, crlf ? serialized.replace(/\n/g, "\r\n") : serialized);
  console.log(`updated ${ENEMY_ELEMENTS_PATH}`);
}

/**
 * The arrival point for LegendsInn door 1 depends on where room 1 ended up in the
 * layout, so the build owns it rather than leaving a hand-copied coordinate to
 * drift the next time the room order changes.
 */
function writeEntrySpawn(x: number, y: number): void {
  const raw = fs.readFileSync(DOOR_SPAWN_PATH, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  // Rewrite in the file's own hand-written style so the diff stays one block.
  const block = `  "${LEVEL_ID}": {${nl}    "1": { "x": ${Math.round(x)}, "y": ${Math.round(y)} }${nl}  }`;
  const existing = new RegExp(`  "${LEVEL_ID}": \\{[\\s\\S]*?\\r?\\n  \\}`);
  let out: string;
  if (existing.test(raw)) {
    out = raw.replace(existing, block);
  } else {
    const close = raw.lastIndexOf(`}${nl}}`);
    if (close === -1) throw new SwfLevelError("door_spawn_map.json has an unexpected shape");
    out = `${raw.slice(0, close + 1)},${nl}${block}${raw.slice(close + 1)}`;
  }
  fs.writeFileSync(DOOR_SPAWN_PATH, out);
  JSON.parse(out.replace(/^﻿/, ""));
  console.log(`${LEVEL_ID} door 1 arrival -> (${Math.round(x)}, ${Math.round(y)})`);
}

function main(): void {
  const { survey, out } = parseArgs(process.argv);

  const target = readSwfFile(BASE_SWF);
  const baseSymbols = readSymbolClasses(target);
  const baseByName = new Map(baseSymbols.map((entry) => [entry.name, entry.id]));

  for (const required of ["a_Door_1", "a_DoorMarker", "a_PlayerSpawn", "a_RoomDirector_BasicBoss", "a_LevelDirector_DefeatBoss", "a_CameraTarget_1"]) {
    if (!baseByName.has(required)) throw new SwfLevelError(`LevelsLD.swf is missing ${required}`);
  }
  for (const letter of LINK_LETTERS) {
    if (!baseByName.has(`a_DoorLocal_${letter}`)) throw new SwfLevelError(`LevelsLD.swf is missing a_DoorLocal_${letter}`);
    if (!baseByName.has(`a_Target_${letter}`)) throw new SwfLevelError(`LevelsLD.swf is missing a_Target_${letter}`);
  }
  if (ROOMS.length - 1 > LINK_LETTERS.length) throw new SwfLevelError("not enough local-door letters for the room chain");

  // 1. Import each region room's artwork.
  interface Placed extends RoomSpec {
    newId: number;
    anchors: Anchor[];
    floor: FloorBand;
    /** Room-local anchors that sit on walkable ground, sorted west to east. */
    layout: Anchor[];
    /** Room-local anchors an enemy can stand on. */
    enemyAnchors: Anchor[];
    /** Level-space offset applied to the room placement. */
    originX: number;
    originY: number;
  }

  /**
   * Anchors in the upper half of the collision span are ledges, flyer perches or
   * editor markers. Everything that has to stand on the ground - spawns, links,
   * and the melee the rooms are populated with - is drawn from the lower half.
   */
  const groundAnchors = (room: { anchors: Anchor[]; floor: FloorBand }): Anchor[] => {
    const waterline = (room.floor.yMin + room.floor.yMax) / 2;
    const low = room.anchors.filter((anchor) => anchor.y >= waterline);
    return low.length >= 2 ? low : room.anchors;
  };
  const placed: Placed[] = [];
  let cursorX = 0;

  for (const spec of ROOMS) {
    const source = readSwfFile(path.join(CLIENT_CONTENT, spec.swf));
    const symbols = readSymbolClasses(source);
    const binding = symbols.find((entry) => entry.name === spec.sourceRoom);
    if (!binding) throw new SwfLevelError(`${spec.swf} has no ${spec.sourceRoom}`);
    const nameById = new Map(symbols.map((entry) => [entry.id, entry.name]));
    const isFunctional = (id: number) => FUNCTIONAL_CLASS.test(nameById.get(id) ?? "");

    const anchors = readAnchors(source, binding.id);
    if (anchors.length < 2) throw new SwfLevelError(`${spec.sourceRoom} has too few anchors to lay out`);
    const floor = readFloorBand(source, binding.id);
    if (!floor) throw new SwfLevelError(`${spec.sourceRoom} has no am_CollisionObject bounds`);

    const bounds = characterBounds(source, binding.id, isFunctional);
    if (!bounds) throw new SwfLevelError(`${spec.sourceRoom} has no drawable bounds`);

    const { idMap } = importCharacters(source, target, [binding.id], isFunctional);
    const newId = idMap.get(binding.id) as number;

    const ground = groundAnchors({ anchors, floor }).sort((a, b) => a.x - b.x);
    const enemyAnchors = ground.filter((anchor) => anchor.enemy);

    // Lay the rooms out west to east, butted together, with every room's floor
    // line on the same level-space baseline so the walk reads as continuous.
    const floorRef = ground[Math.floor(ground.length / 2)].y;
    const originX = cursorX - bounds.xMin / 20;
    const originY = -floorRef;
    cursorX += (bounds.xMax - bounds.xMin) / 20 + ROOM_GAP;

    placed.push({ ...spec, newId, anchors, floor, layout: ground, enemyAnchors, originX, originY });
    console.log(
      `${spec.region.padEnd(16)} ${spec.sourceRoom.padEnd(30)} -> character ${newId}` +
        `  anchors ${anchors.length} (${anchors.filter((a) => a.enemy).length} cue)` +
        `  size ${((bounds.xMax - bounds.xMin) / 20).toFixed(0)}x${((bounds.yMax - bounds.yMin) / 20).toFixed(0)}`,
    );
  }

  if (survey) {
    for (const room of placed) {
      const xs = room.anchors.map((a) => a.x);
      const ys = room.anchors.map((a) => a.y);
      console.log(
        `${room.roomClass} origin (${room.originX.toFixed(0)}, ${room.originY.toFixed(0)}) ` +
          `anchors x[${Math.min(...xs).toFixed(0)},${Math.max(...xs).toFixed(0)}] y[${Math.min(...ys).toFixed(0)},${Math.max(...ys).toFixed(0)}]`,
      );
    }
    console.log("survey only - LevelsLI.swf not written");
    return;
  }

  // 2. Import the link portal. One character placed in eight rooms - a class can
  //    only bind one character, but that character can be placed as often as we like.
  const portalSwf = readSwfFile(path.join(CLIENT_CONTENT, PORTAL_SWF));
  const portalSource = readSymbolClasses(portalSwf).find((entry) => entry.name === PORTAL_SOURCE_CLASS);
  if (!portalSource) throw new SwfLevelError(`${PORTAL_SWF} has no ${PORTAL_SOURCE_CLASS}`);
  const portalArtId = importCharacters(portalSwf, target, [portalSource.id]).idMap.get(
    portalSource.id,
  ) as number;

  // 3. Rename the sandbox's spare classes into the ones this level binds.
  const renames = new Map<string, string>([
    [LEVEL_DONOR_CLASS, LEVEL_CLASS],
    [PORTAL_ART_DONOR, PORTAL_ART_CLASS],
  ]);
  for (const spec of ROOMS) renames.set(spec.donorClass, spec.roomClass);
  for (const [from, to] of CUE_RENAMES) renames.set(from, to);
  renameAbcStrings(target, renames);
  // baseByName is keyed by the sandbox's original names; let the new names through too.
  for (const [from, to] of renames) {
    const id = baseByName.get(from);
    if (id !== undefined) baseByName.set(to, id);
  }

  // 4. Fill each room with spawn points, links and enemies.
  let entrySpawn: { x: number; y: number } | null = null;
  const enemyCounts = new Map<string, number>();
  const countEnemy = (cueClass: string) => {
    const entName = cueClass.slice(3);
    enemyCounts.set(entName, (enemyCounts.get(entName) ?? 0) + 1);
  };
  for (let index = 0; index < placed.length; index += 1) {
    const room = placed[index];
    const roomIndex = target.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === room.newId,
    );
    if (roomIndex === -1) throw new SwfLevelError(`imported room ${room.roomClass} not found`);
    const roomTag = target.tags[roomIndex];
    let depth = nextFreeDepth(roomTag);
    const additions: SwfTag[] = [];
    const place = (charId: number, anchor: Anchor, name?: string, scale?: number) => {
      additions.push(
        buildPlaceObject2({
          depth: depth++,
          charId,
          x: anchor.x,
          y: anchor.y,
          name,
          scaleX: scale,
          scaleY: scale,
        }),
      );
    };

    const layout = room.layout;
    const entry = layout[0];
    const exit = layout[layout.length - 1];
    const middle = layout[Math.floor(layout.length / 2)];

    if (index === 0) {
      entrySpawn = { x: room.originX + entry.x, y: room.originY + entry.y };
      place(baseByName.get("a_PlayerSpawn") as number, entry);
      place(baseByName.get("a_Door_1") as number, entry);
      place(baseByName.get("a_DoorMarker") as number, { x: entry.x, y: entry.y - 330, enemy: false });
    } else {
      place(baseByName.get(`a_Target_${LINK_LETTERS[index - 1]}`) as number, entry);
    }
    if (index < placed.length - 1) {
      // a_DoorLocal_* is an invisible marker, so the player needs something to
      // aim at: draw a portal and stretch the marker over it for the hit area.
      // This is the same pairing a_Room_LDArena1_01 uses (am_PortalDoor scaled
      // 1.47 on top of the ac_TunnelPortal it teleports through).
      place(portalArtId, exit);
      place(baseByName.get(`a_DoorLocal_${LINK_LETTERS[index]}`) as number, exit, undefined, LINK_MARKER_SCALE);
    }
    place(baseByName.get("a_CameraTarget_1") as number, middle);

    const stride = Math.max(1, Math.ceil(room.enemyAnchors.length / MAX_ENEMIES_PER_ROOM));
    const enemyAnchors = room.enemyAnchors.filter((_, position) => position % stride === 0);
    for (let slot = 0; slot < enemyAnchors.length; slot += 1) {
      const className = room.enemies[slot % room.enemies.length];
      const charId = baseByName.get(className);
      if (charId === undefined) throw new SwfLevelError(`${className} has no character in LevelsLD.swf`);
      countEnemy(className);
      place(charId, enemyAnchors[slot]);
    }

    if (index === placed.length - 1) {
      const bossChar = baseByName.get(BOSS_CUE_CLASS);
      if (bossChar === undefined) throw new SwfLevelError(`${BOSS_CUE_CLASS} has no character in LevelsLD.swf`);
      countEnemy(BOSS_CUE_CLASS);
      place(bossChar, exit, BOSS_INSTANCE);
      place(baseByName.get("a_RoomDirector_BasicBoss") as number, { x: exit.x, y: exit.y - 600, enemy: false });
    }

    console.log(
      `${room.roomClass} entry (${entry.x.toFixed(0)}, ${entry.y.toFixed(0)}) exit (${exit.x.toFixed(0)}, ${exit.y.toFixed(0)})` +
        ` floor y[${room.floor.yMin.toFixed(0)},${room.floor.yMax.toFixed(0)}] enemies ${enemyAnchors.length}`,
    );

    const inner = spriteInnerTags(roomTag);
    const showFrame = inner.findIndex((tag) => tag.code === 1);
    inner.splice(showFrame === -1 ? inner.length - 1 : showFrame, 0, ...additions);
    target.tags[roomIndex] = rebuildSprite(roomTag, inner);
  }

  // 5. Assemble the level sprite itself, over an opaque backdrop.
  const extent = placed.reduce(
    (box, room) => {
      const bounds = characterBounds(target, room.newId) as Bounds;
      return {
        xMin: Math.min(box.xMin, room.originX + bounds.xMin / 20),
        xMax: Math.max(box.xMax, room.originX + bounds.xMax / 20),
        yMin: Math.min(box.yMin, room.originY + bounds.yMin / 20),
        yMax: Math.max(box.yMax, room.originY + bounds.yMax / 20),
      };
    },
    { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity },
  );

  const backdropId = maxCharacterId(target) + 1;
  appendCharacterTag(
    target,
    buildSolidRectShape(
      backdropId,
      {
        xMin: Math.round((extent.xMin - BACKDROP_MARGIN) * 20),
        xMax: Math.round((extent.xMax + BACKDROP_MARGIN) * 20),
        yMin: Math.round((extent.yMin - BACKDROP_MARGIN) * 20),
        yMax: Math.round((extent.yMax + BACKDROP_MARGIN) * 20),
      },
      BACKDROP_RGB,
    ),
  );

  const levelId = maxCharacterId(target) + 1;
  const levelSprite = buildSprite({
    id: levelId,
    placements: [
      { depth: 1, charId: backdropId, x: 0, y: 0 },
      ...placed.map((room, index) => ({
        depth: index + 2,
        charId: room.newId,
        x: room.originX,
        y: room.originY,
      })),
      {
        depth: placed.length + 2,
        charId: baseByName.get("a_LevelDirector_DefeatBoss") as number,
        x: placed[0].originX,
        y: placed[0].originY - 600,
      },
    ],
  });
  target.tags.splice(
    target.tags.findIndex((tag) => tag.code === 76),
    0,
    levelSprite,
  );

  // 6. Rewrite the symbol table. Renamed cue classes keep their sandbox art; the
  //    room, portal and level classes bind to what was just built. Every donor
  //    whose class was renamed away has to be rebound or dropped - a SymbolClass
  //    entry naming a class that no longer exists is fatal at load.
  const cueRenameMap = new Map(CUE_RENAMES);
  const reboundDonors = new Set([
    LEVEL_DONOR_CLASS,
    PORTAL_ART_DONOR,
    ...ROOMS.map((spec) => spec.donorClass),
  ]);
  const rebound = baseSymbols
    .filter((entry) => !reboundDonors.has(entry.name))
    .map((entry) => ({ id: entry.id, name: cueRenameMap.get(entry.name) ?? entry.name }))
    .concat(placed.map((room) => ({ id: room.newId, name: room.roomClass })))
    .concat([
      { id: portalArtId, name: PORTAL_ART_CLASS },
      { id: levelId, name: LEVEL_CLASS },
    ]);
  writeSymbolClasses(target, rebound);

  const size = target.tags.reduce((total, tag) => total + encodeTag(tag).length, 0);
  const totalEnemies = [...enemyCounts.values()].reduce((sum, count) => sum + count, 0);
  console.log(`level sprite ${levelId} -> ${LEVEL_CLASS}, ${placed.length} rooms, boss ${BOSS_CUE_CLASS}`);
  console.log(`${totalEnemies} enemies across ${enemyCounts.size} types`);
  console.log(`uncompressed tag payload: ${size} bytes`);

  writeSwfFile(out, target);
  console.log(`wrote ${out}`);
  writeEnemyManifest(enemyCounts, placed.map((room) => room.roomClass));
  if (!entrySpawn) throw new SwfLevelError("no entry spawn was recorded for room 1");
  writeEntrySpawn(entrySpawn.x, entrySpawn.y);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
