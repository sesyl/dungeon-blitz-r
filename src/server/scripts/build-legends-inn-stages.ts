/**
 * Builds the nine Legends' Inn stage SWFs.
 *
 * Legends' Inn is a tour of Ellyria: one authored dungeon from each region, kept
 * whole. Each stage SWF is the region SWF trimmed down to the single level the
 * stage uses, with one addition - an exit portal in the boss room that leads to
 * the next stage.
 *
 * Trimming instead of re-authoring is what makes "the whole dungeon" possible.
 * Every room, backdrop, collision object, local door, cue and room script is the
 * shipped one, still bound to the class the region's own ABC defines, so nothing
 * has to be rebuilt out of donor classes the way a generated level does. The ABC
 * is carried over untouched; only characters the level does not reach are
 * dropped, along with the SymbolClass entries that named them.
 *
 * Sharing class names with the region SWF is safe: ResourceManager loads every
 * level file into `new ApplicationDomain(ApplicationDomain.currentDomain)`, so
 * two level SWFs never see each other's definitions.
 *
 * Stages 1-8 lose their a_LevelDirector placement. The dungeon is not over when
 * its boss dies - the portal opens the way on - and the level director is what
 * would otherwise end the run client-side.
 *
 * Usage: npm exec ts-node scripts/build-legends-inn-stages.ts [--survey] [--stage <n>]
 */
import * as fs from "fs";
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  buildPlaceObject2,
  characterBounds,
  characterId,
  characterTagsById,
  collectDependencies,
  encodeTag,
  importCharacters,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";
import {
  ENTRY_DOOR_ID,
  ENTRY_LEVEL,
  LEGENDS_INN_LEVEL,
  LEGENDS_INN_STAGES,
  LegendsInnStage,
  RETURN_DOOR_ID,
} from "./legendsInnStages";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const OUT_DIR = path.join(CLIENT_CONTENT, "cbp");

/** The portal drawn on the exit of every stage, borrowed from Bridgetown. */
const PORTAL_SWF = "cam/LevelsBT.swf";
const PORTAL_SOURCE_CLASS = "a_Animation_Portal";
/** How large the portal is drawn, and how far its middle sits above the floor. */
const PORTAL_SCALE = 0.8;
const PORTAL_LIFT = 90;

/**
 * Door ids the exit portal may take, best first. Which one a stage ends up with
 * depends on the classes its region SWF exports, so the stage reports it and the
 * server config follows.
 */
const EXIT_DOOR_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How far to the side of the boss the portal stands, in room-local pixels. */
const EXIT_STANDOFF = 250;

interface RoomInfo {
  charId: number;
  className: string;
  /** Level-space offset of the room placement, in pixels. */
  x: number;
  y: number;
}

interface Marker {
  className: string;
  instance: string | null;
  /** Room-local position, in pixels. */
  x: number;
  y: number;
}

function parseArgs(argv: string[]): { survey: boolean; stages: LegendsInnStage[] } {
  let survey = false;
  let only: number | null = null;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--survey") survey = true;
    else if (arg === "--stage") only = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec ts-node scripts/build-legends-inn-stages.ts [--survey] [--stage <n>]");
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  if (only !== null && (!Number.isInteger(only) || only < 1 || only > LEGENDS_INN_STAGES.length)) {
    throw new SwfLevelError(`--stage must be between 1 and ${LEGENDS_INN_STAGES.length}`);
  }
  return { survey, stages: only === null ? LEGENDS_INN_STAGES : [LEGENDS_INN_STAGES[only - 1]] };
}

function spriteChildren(swf: SwfFile, id: number): Array<{ charId: number; instance: string | null; x: number; y: number }> {
  const tag = characterTagsById(swf).get(id);
  if (!tag || tag.code !== TAG_DEFINE_SPRITE) return [];
  const children: Array<{ charId: number; instance: string | null; x: number; y: number }> = [];
  for (const inner of spriteInnerTags(tag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.charId === null) continue;
    children.push({
      charId: place.charId,
      instance: place.name,
      x: place.matrix ? place.matrix.translateX / 20 : 0,
      y: place.matrix ? place.matrix.translateY / 20 : 0,
    });
  }
  return children;
}

function readRooms(swf: SwfFile, levelId: number, nameById: Map<number, string>): RoomInfo[] {
  const rooms: RoomInfo[] = [];
  for (const child of spriteChildren(swf, levelId)) {
    const className = nameById.get(child.charId) ?? "";
    if (!/^a_Room_/.test(className)) continue;
    rooms.push({ charId: child.charId, className, x: child.x, y: child.y });
  }
  return rooms;
}

/** Functional children of a room - the ones the client resolves by class name. */
function readMarkers(swf: SwfFile, roomId: number, nameById: Map<number, string>): Marker[] {
  const markers: Marker[] = [];
  for (const child of spriteChildren(swf, roomId)) {
    const className = nameById.get(child.charId) ?? "";
    if (!className && child.instance === null) continue;
    markers.push({ className, instance: child.instance, x: child.x, y: child.y });
  }
  return markers;
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
 * The room the dungeon's fight ends in.
 *
 * A room named for its boss is the authored answer and wins outright. Otherwise
 * `am_Boss` marks a boss - but several rooms can carry one, since a mid-dungeon
 * mini-boss is marked the same way, so the last one placed is taken: rooms are
 * placed in the order they were authored and the finale is authored last.
 */
function findBossRoom(swf: SwfFile, rooms: RoomInfo[], nameById: Map<number, string>, override?: string): {
  room: RoomInfo;
  anchor: Marker | null;
} {
  const bossAnchor = (room: RoomInfo) =>
    readMarkers(swf, room.charId, nameById).find((marker) => marker.instance === "am_Boss") ?? null;

  if (override) {
    const room = rooms.find((entry) => entry.className === override);
    if (!room) throw new SwfLevelError(`no room named ${override} in this level`);
    return { room, anchor: bossAnchor(room) };
  }
  const named = rooms.filter((room) => /boss/i.test(room.className));
  if (named.length > 0) {
    const room = named[named.length - 1];
    return { room, anchor: bossAnchor(room) };
  }
  const marked = rooms.filter((room) => bossAnchor(room) !== null);
  if (marked.length > 0) {
    const room = marked[marked.length - 1];
    return { room, anchor: bossAnchor(room) };
  }
  return { room: rooms[rooms.length - 1], anchor: null };
}

/**
 * Where the exit portal stands, in room-local pixels.
 *
 * The boss anchor is the safest floor evidence a boss room offers - a boss is
 * authored standing on walkable ground - and any other functional marker is the
 * same kind of evidence. The portal is then stood off to one side so it does not
 * cover the fight, towards the middle of the room so the standoff cannot walk it
 * out through a wall.
 */
function exitAnchor(
  swf: SwfFile,
  room: RoomInfo,
  anchor: Marker | null,
  nameById: Map<number, string>,
): { x: number; y: number } {
  let base = anchor ? { x: anchor.x, y: anchor.y } : null;
  if (!base) {
    const markers = readMarkers(swf, room.charId, nameById).filter((marker) =>
      /^(ac_|a_Target_|a_DoorLocal_|a_PlayerSpawn)/.test(marker.className),
    );
    if (markers.length === 0) throw new SwfLevelError(`${room.className} has no anchor to place the exit portal on`);
    // Furthest into the room, so the portal reads as the way onward.
    base = markers.reduce((best, marker) => (marker.x > best.x ? marker : best), markers[0]);
  }
  const bounds = characterBounds(swf, room.charId);
  if (!bounds) return base;
  const middle = (bounds.xMin + bounds.xMax) / 40;
  return { x: base.x + (base.x > middle ? -EXIT_STANDOFF : EXIT_STANDOFF), y: base.y };
}

/**
 * A door class the region SWF exports and the level does not already place, so
 * both the class and the door id behind it are free for the exit.
 */
function freeDoorClass(
  swf: SwfFile,
  symbols: Array<{ id: number; name: string }>,
  rooms: RoomInfo[],
  nameById: Map<number, string>,
): { className: string; doorId: number; charId: number } {
  const used = new Set<string>();
  for (const room of rooms) {
    for (const marker of readMarkers(swf, room.charId, nameById)) used.add(marker.className);
  }
  for (const doorId of EXIT_DOOR_IDS) {
    const className = `a_Door_${doorId}`;
    if (used.has(className)) continue;
    const binding = symbols.find((entry) => entry.name === className);
    if (binding) return { className, doorId, charId: binding.id };
  }
  throw new SwfLevelError(`no free a_Door_ class in this SWF for the exit portal`);
}

/**
 * Moves a set of characters, and everything they depend on, in front of a sprite
 * so that sprite may place them.
 *
 * Flash constructs a sprite from the definitions it has already seen. A
 * placement naming a character defined further down the file throws
 * `Error #2136: ... contains invalid data` out of `constructChildren`, blamed on
 * the sprite's class rather than on the placement. Imported characters land just
 * ahead of SymbolClass - after every room - so they always need this.
 */
function hoistBefore(swf: SwfFile, ids: Set<number>, spriteId: number): void {
  const spriteIndex = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === spriteId,
  );
  if (spriteIndex === -1) throw new SwfLevelError(`sprite ${spriteId} not found`);

  const needed = new Set<number>();
  for (const id of ids) for (const dependency of collectDependencies(swf, [id])) needed.add(dependency);
  needed.delete(spriteId);

  const moving: SwfTag[] = [];
  const kept: SwfTag[] = [];
  swf.tags.forEach((tag, index) => {
    const id = characterId(tag);
    if (id !== null && index > spriteIndex && needed.has(id)) moving.push(tag);
    else kept.push(tag);
  });
  if (moving.length === 0) return;

  const movedIndex = kept.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === spriteId,
  );
  kept.splice(movedIndex, 0, ...moving);
  swf.tags = kept;
}

/**
 * Every placement must name a character the file has already defined. Shipped
 * levels do place characters that were deleted outright, which Flash ignores, so
 * only a definition that arrives too late is an error.
 */
function assertDefinitionOrder(swf: SwfFile, label: string): void {
  const definedAt = new Map<number, number>();
  swf.tags.forEach((tag, index) => {
    const id = characterId(tag);
    if (id !== null && !definedAt.has(id)) definedAt.set(id, index);
  });
  swf.tags.forEach((tag, index) => {
    if (tag.code !== TAG_DEFINE_SPRITE) return;
    for (const inner of spriteInnerTags(tag)) {
      if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
      const place = parsePlace(inner);
      if (place.charId === null) continue;
      const definition = definedAt.get(place.charId);
      if (definition !== undefined && definition > index) {
        throw new SwfLevelError(
          `${label}: sprite ${tag.data.readUInt16LE(0)} places character ${place.charId}, which is defined later`,
        );
      }
    }
  });
}

/** Shape characters. Nothing that extends MovieClip can be bound to one. */
const SHAPE_TAGS = new Set([2, 22, 32, 83]);

/**
 * Every class the level binds must still name the same kind of character it was
 * authored against. A trim frees ids and an import reuses them, so a stale
 * binding can silently land on unrelated artwork; a class that extends MovieClip
 * bound to a shape is `Error #2136` at the moment that shape is constructed.
 */
function assertBindingsMatchTags(swf: SwfFile, label: string): void {
  const byId = characterTagsById(swf);
  for (const binding of readSymbolClasses(swf)) {
    const tag = byId.get(binding.id);
    if (!tag) throw new SwfLevelError(`${label}: ${binding.name} is bound to missing character ${binding.id}`);
    // Fonts and text fields are bound too and are fine; a shape is not, because
    // every a_/ac_ class in a level SWF extends MovieClip.
    if (SHAPE_TAGS.has(tag.code)) {
      throw new SwfLevelError(
        `${label}: ${binding.name} is bound to character ${binding.id}, which is a shape (tag ${tag.code})`,
      );
    }
  }
}

/**
 * Font characters, which survive a trim whatever the dependency walk says.
 *
 * `DefineEditText` is not one of the character tags swfLevelUtils models, so it
 * is carried over untouched - but nothing ever walks it, and the font it names
 * is a real character that the walk therefore never reaches. An EditText left
 * pointing at a dropped font makes the sprite holding it invalid, which Flash
 * reports as `Error #2136` against that sprite's class. These levels carry one or
 * two fonts each, so keeping all of them costs nothing.
 */
const FONT_TAGS = new Set([10, 48, 75]);

/** Drops every character the kept roots do not reach, and the bindings that named them. */
function trim(swf: SwfFile, keep: Set<number>): void {
  swf.tags = swf.tags.filter((tag) => {
    const id = characterId(tag);
    if (id !== null) return keep.has(id) || FONT_TAGS.has(tag.code);
    if (tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3) {
      // Root-frame placements of characters that are gone would otherwise draw
      // whatever ends up at that id.
      const place = parsePlace(tag);
      return place.charId === null || keep.has(place.charId);
    }
    return true;
  });
}

interface StageBuild {
  spec: LegendsInnStage;
  /** Door the exit portal ended up on; the chain in door_map follows it. */
  exitDoorId: number;
  /** Level-space a_PlayerSpawn, which is where an arrival lands. */
  spawn: { x: number; y: number } | null;
}

function buildStage(spec: LegendsInnStage, stageIndex: number, survey: boolean): StageBuild | null {
  const source = readSwfFile(path.join(CLIENT_CONTENT, spec.swf));
  const symbols = readSymbolClasses(source);
  const nameById = new Map(symbols.map((entry) => [entry.id, entry.name]));

  const levelBinding = symbols.find((entry) => entry.name === spec.levelClass);
  if (!levelBinding) throw new SwfLevelError(`${spec.swf} has no ${spec.levelClass}`);

  const rooms = readRooms(source, levelBinding.id, nameById);
  if (rooms.length === 0) throw new SwfLevelError(`${spec.levelClass} has no a_Room_ children`);

  const boss = findBossRoom(source, rooms, nameById, spec.bossRoom);
  const anchor = exitAnchor(source, boss.room, boss.anchor, nameById);
  const door = freeDoorClass(source, symbols, rooms, nameById);

  // Where the player lands coming in. Dungeons spawn arrivals on a_PlayerSpawn.
  let spawn: { x: number; y: number } | null = null;
  let entranceDoor: { x: number; y: number } | null = null;
  for (const room of rooms) {
    for (const marker of readMarkers(source, room.charId, nameById)) {
      if (marker.className === "a_PlayerSpawn" && !spawn) spawn = { x: room.x + marker.x, y: room.y + marker.y };
      if (marker.className === "a_Door_1" && !entranceDoor) entranceDoor = { x: room.x + marker.x, y: room.y + marker.y };
    }
  }

  const levelDirectors = spriteChildren(source, levelBinding.id).filter((child) =>
    /^a_LevelDirector/.test(nameById.get(child.charId) ?? ""),
  );

  if (survey) {
    console.log(`\n=== ${spec.levelName}  ${spec.region}  ${spec.swf}/${spec.levelClass}`);
    console.log(`    rooms ${rooms.length}: ${rooms.map((room) => room.className).join(", ")}`);
    console.log(`    boss room ${boss.room.className}${boss.anchor ? ` (am_Boss @ ${boss.anchor.x.toFixed(0)}, ${boss.anchor.y.toFixed(0)})` : " (no am_Boss, using last room)"}`);
    console.log(`    exit door ${door.className} at room-local (${anchor.x.toFixed(0)}, ${anchor.y.toFixed(0)}), level-space (${(boss.room.x + anchor.x).toFixed(0)}, ${(boss.room.y + anchor.y).toFixed(0)})`);
    console.log(`    a_PlayerSpawn ${spawn ? `(${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})` : "MISSING"}, a_Door_1 ${entranceDoor ? `(${entranceDoor.x.toFixed(0)}, ${entranceDoor.y.toFixed(0)})` : "MISSING"}`);
    console.log(`    level directors: ${levelDirectors.map((child) => nameById.get(child.charId)).join(", ") || "(none)"}`);
    const keep = collectDependencies(source, [levelBinding.id]);
    console.log(`    keeps ${keep.size} of ${characterTagsById(source).size} characters`);
    console.log(`    spare a_Animation: ${symbols.filter((entry) => /^a_Animation/.test(entry.name) && !keep.has(entry.id)).map((entry) => entry.name).join(", ") || "(none)"}`);
    return null;
  }

  // 1. Trim to the one level, plus the door marker character the exit needs.
  const fontsBefore = source.tags.filter((tag) => FONT_TAGS.has(tag.code)).length;
  const keep = collectDependencies(source, [levelBinding.id]);
  for (const id of collectDependencies(source, [door.charId])) keep.add(id);
  trim(source, keep);
  const fontsAfter = source.tags.filter((tag) => FONT_TAGS.has(tag.code)).length;
  if (fontsAfter !== fontsBefore) {
    throw new SwfLevelError(`${spec.levelName}: trim dropped ${fontsBefore - fontsAfter} of ${fontsBefore} fonts`);
  }
  // Which characters may still carry a class, decided before anything is
  // imported. An import reuses the ids the trim just freed, so a binding kept on
  // the strength of "some character has that id now" would hand a dead class -
  // a room, a level - to a shape that only happens to have inherited its id, and
  // Flash cannot build a MovieClip subclass out of a shape (Error #2136).
  const boundable = new Set(source.tags.map(characterId).filter((id): id is number => id !== null));

  // 2. Bring in the portal artwork and place it with the door on top. The
  //    artwork stays unbound, the way a room's own scenery is: only the door
  //    marker needs a class, and a door marker is drawn hidden.
  const portalSwf = readSwfFile(path.join(CLIENT_CONTENT, PORTAL_SWF));
  const portalSource = readSymbolClasses(portalSwf).find((entry) => entry.name === PORTAL_SOURCE_CLASS);
  if (!portalSource) throw new SwfLevelError(`${PORTAL_SWF} has no ${PORTAL_SOURCE_CLASS}`);
  const portalId = importCharacters(portalSwf, source, [portalSource.id]).idMap.get(portalSource.id) as number;
  hoistBefore(source, new Set([portalId, door.charId]), boss.room.charId);

  const roomIndex = source.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === boss.room.charId,
  );
  if (roomIndex === -1) throw new SwfLevelError(`boss room ${boss.room.className} was trimmed away`);
  const roomTag = source.tags[roomIndex];
  const depth = nextFreeDepth(roomTag);
  const portalAt = {
    x: anchor.x + (spec.exitOffset?.x ?? 0),
    y: anchor.y + (spec.exitOffset?.y ?? 0),
  };
  const inner = spriteInnerTags(roomTag);
  const showFrame = inner.findIndex((tag) => tag.code === 1);
  inner.splice(
    showFrame === -1 ? inner.length - 1 : showFrame,
    0,
    buildPlaceObject2({
      depth,
      charId: portalId,
      x: portalAt.x,
      y: portalAt.y - PORTAL_LIFT,
      scaleX: PORTAL_SCALE,
      scaleY: PORTAL_SCALE,
    }),
    buildPlaceObject2({ depth: depth + 1, charId: door.charId, x: portalAt.x, y: portalAt.y }),
  );
  source.tags[roomIndex] = rebuildSprite(roomTag, inner);

  // 3. Stages before the last must not end when their boss dies.
  const isLastStage = stageIndex === LEGENDS_INN_STAGES.length - 1;
  if (!isLastStage && levelDirectors.length > 0) {
    const levelIndex = source.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === levelBinding.id,
    );
    if (levelIndex === -1) throw new SwfLevelError(`level sprite ${spec.levelClass} was trimmed away`);
    const levelTag = source.tags[levelIndex];
    const directorIds = new Set(levelDirectors.map((child) => child.charId));
    const kept = spriteInnerTags(levelTag).filter((tag) => {
      if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
      const place = parsePlace(tag);
      return place.charId === null || !directorIds.has(place.charId);
    });
    source.tags[levelIndex] = rebuildSprite(levelTag, kept);
  }

  // 4. Rewrite the bindings: a SymbolClass entry naming a character that the
  //    trim removed is fatal at load, so only what survived the trim may stay.
  writeSymbolClasses(source, symbols.filter((entry) => boundable.has(entry.id)));
  assertDefinitionOrder(source, spec.levelName);
  assertBindingsMatchTags(source, spec.levelName);

  const out = path.join(OUT_DIR, spec.outFile);
  writeSwfFile(out, source);
  const size = fs.statSync(out).size;
  console.log(
    `${spec.levelName.padEnd(12)} ${spec.region.padEnd(16)} ${rooms.length} rooms  boss ${boss.room.className}  ` +
      `exit ${door.className} @ (${(boss.room.x + portalAt.x).toFixed(0)}, ${(boss.room.y + portalAt.y).toFixed(0)})  ` +
      `${isLastStage ? "keeps" : "drops"} level director  -> ${spec.outFile} ${(size / 1024 / 1024).toFixed(2)} MB`,
  );
  if (spawn) console.log(`             a_PlayerSpawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})`);
  return { spec, exitDoorId: door.doorId, spawn };
}

// ---------------------------------------------------------------------------
// Configuration the stages imply
//
// Which door the portal landed on and where a stage's spawn is are decided by
// the build, so the build writes the config that depends on them rather than
// leaving hand-copied values to drift the next time the stage list changes.
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, "..", "data");
const CLIENT_XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const SWZ_LIST_DIR = path.join(CLIENT_CONTENT, "cbq");
const MASTER_FILE_LISTS = [
  path.join(CLIENT_XML_DIR, "MasterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_1.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_2.xml"),
];

/** Enemy tier, matching what the level Legends' Inn replaced was set to. */
const STAGE_TIER = 30;

/** JSON in this tree is CRLF and some of it carries a BOM, which JSON.parse rejects. */
function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
}

function writeText(filePath: string, text: string, crlf: boolean): void {
  fs.writeFileSync(filePath, crlf ? text.replace(/\r?\n/g, "\r\n") : text);
}

/** Registers each stage as its own dungeon level, in the block reserved for them. */
function writeLevelConfig(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "level_config.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const config: Record<string, string> = JSON.parse(raw);

  const entries: Array<[string, string]> = [];
  let placed = false;
  const stageEntries = (): Array<[string, string]> =>
    builds.map((build) => [
      build.spec.levelName,
      `${build.spec.outFile}/${build.spec.levelClass} ${STAGE_TIER} ${STAGE_TIER} true`,
    ]);

  for (const [key, value] of Object.entries(config)) {
    if (LEGENDS_INN_LEVEL.test(key)) continue;
    entries.push([key, value]);
    if (key.includes("LEGENDS INN")) {
      entries.push(...stageEntries());
      placed = true;
    }
  }
  if (!placed) entries.push(...stageEntries());

  writeText(filePath, `${JSON.stringify(Object.fromEntries(entries), null, 4)}\n`, raw.includes("\r\n"));
  console.log(`level_config.json  ${builds.length} stages`);
}

/** Chains the stages: entry -> 1 -> 2 -> ... -> 9 -> back out. */
function writeDoorMap(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "door_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const doors: Array<[[string, number], string]> = JSON.parse(raw);

  const kept = doors.filter(
    ([[level, doorId], target]) =>
      !LEGENDS_INN_LEVEL.test(level) && !LEGENDS_INN_LEVEL.test(target) && !(level === ENTRY_LEVEL && doorId === ENTRY_DOOR_ID),
  );
  const added: Array<[[string, number], string]> = [[[ENTRY_LEVEL, ENTRY_DOOR_ID], builds[0].spec.levelName]];
  for (let index = 0; index < builds.length; index += 1) {
    const build = builds[index];
    const next = builds[index + 1];
    added.push([[build.spec.levelName, RETURN_DOOR_ID], ENTRY_LEVEL]);
    added.push([[build.spec.levelName, build.exitDoorId], next ? next.spec.levelName : ENTRY_LEVEL]);
  }

  const trailing = raw.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(filePath, JSON.stringify([...kept, ...added]) + trailing);
  console.log(`door_map.json      ${added.length} doors`);
}

/**
 * Arrival points. A dungeon lands its arrivals on a_PlayerSpawn, and both doors
 * a stage owns are entered from outside it, so both point at the same place.
 */
function writeDoorSpawns(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "door_spawn_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const spawns: Record<string, Record<string, { x: number; y: number }>> = JSON.parse(raw);

  for (const key of Object.keys(spawns)) if (LEGENDS_INN_LEVEL.test(key)) delete spawns[key];
  for (const build of builds) {
    if (!build.spawn) continue;
    spawns[build.spec.levelName] = { [String(RETURN_DOOR_ID)]: { x: Math.round(build.spawn.x), y: Math.round(build.spawn.y) } };
  }

  // Re-emitted in the file's own hand-written shape so the diff stays local.
  const levels = Object.entries(spawns).map(([level, doors]) => {
    const rows = Object.entries(doors).map(([doorId, point]) => `    "${doorId}": { "x": ${point.x}, "y": ${point.y} }`);
    return `  "${level}": {\n${rows.join(",\n")}\n  }`;
  });
  writeText(filePath, `{\n${levels.join(",\n")}\n}\n`, raw.includes("\r\n"));
  console.log(`door_spawn_map.json ${builds.filter((build) => build.spawn).length} arrivals`);
}

/**
 * Completion. Only the last stage ends the run: the stages before it are a road,
 * and a road that reports itself finished would hand out the reward eight times
 * over and close the dungeon under the party's feet.
 */
function writeCompletionConditions(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "dungeon_completion_conditions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const crlf = raw.includes("\r\n");
  const conditions = readJson(filePath).levels as Record<string, unknown>;

  const lines = raw.replace(/\r\n/g, "\n").split("\n").filter((line) => !/^\s*"LegendsInn\d*"\s*:/.test(line));
  const isEntry = (line: string) => /^\s{4}"[^"]+"\s*:/.test(line);
  let lastEntry = -1;
  for (let index = 0; index < lines.length; index += 1) if (isEntry(lines[index])) lastEntry = index;
  if (lastEntry === -1) throw new SwfLevelError("dungeon_completion_conditions.json has no level entries");
  if (!lines[lastEntry].trimEnd().endsWith(",")) lines[lastEntry] = `${lines[lastEntry].trimEnd()},`;

  const added = builds.map((build, index) => {
    const last = index === builds.length - 1;
    const inherited = conditions[build.spec.sourceLevelName];
    if (last && !inherited) throw new SwfLevelError(`no completion condition to inherit from ${build.spec.sourceLevelName}`);
    const condition = last ? inherited : { mode: "disabled" };
    return `    "${build.spec.levelName}": ${JSON.stringify(condition)}${index === builds.length - 1 ? "" : ","}`;
  });
  lines.splice(lastEntry + 1, 0, ...added);

  writeText(filePath, lines.join("\n"), crlf);
  console.log(`dungeon_completion_conditions.json  ${builds.length - 1} disabled, 1 inherited`);
}

/** The dungeon entry screen's enemy catalog. Same rooms, so the same catalog. */
function writeEnemyElements(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "dungeon_enemy_elements.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const manifest = readJson(filePath) as Record<string, unknown>;

  for (const key of Object.keys(manifest)) if (LEGENDS_INN_LEVEL.test(key)) delete manifest[key];
  for (const build of builds) {
    const inherited = manifest[build.spec.sourceLevelName];
    if (!inherited) throw new SwfLevelError(`no enemy catalog to inherit from ${build.spec.sourceLevelName}`);
    manifest[build.spec.levelName] = inherited;
  }
  writeText(filePath, `${JSON.stringify(manifest, null, 2)}\n`, raw.includes("\r\n"));
  console.log(`dungeon_enemy_elements.json ${builds.length} catalogs`);
}

/** Lists the client downloads level SWFs from. */
function writeMasterFileLists(builds: StageBuild[]): void {
  const rows = builds.map((build) => {
    const size = Math.round(fs.statSync(path.join(OUT_DIR, build.spec.outFile)).size / 1024);
    return `  <Level Version="cbp"\t\t\t\t Size="${size}" Name="${build.spec.outFile}" />`;
  });
  // These files mix line endings, so they are edited in place rather than split
  // and rejoined - normalising them would rewrite every untouched row.
  const stageRow = /^[^\n]*Name="LevelsLI\d*\.swf"[^\n]*\r?\n/gm;
  for (const filePath of MASTER_FILE_LISTS) {
    if (!fs.existsSync(filePath)) throw new SwfLevelError(`${filePath} not found`);
    const raw = fs.readFileSync(filePath, "utf8");
    const eol = /Name="LevelsLD\.swf"[^\n]*(\r?\n)/.exec(raw)?.[1] ?? (raw.includes("\r\n") ? "\r\n" : "\n");
    const block = rows.join(eol) + eol;

    const existing = [...raw.matchAll(stageRow)];
    let out: string;
    if (existing.length > 0) {
      const first = existing[0].index as number;
      out = raw.replace(stageRow, (_match, offset) => (offset === first ? block : ""));
    } else {
      // Level rows are alphabetical, and LevelsLI0N sorts where LevelsLI did.
      const anchor = /^[^\n]*Name="LevelsN[^\n]*\r?\n/m.exec(raw);
      if (!anchor) throw new SwfLevelError(`${filePath} has no place to list the stages`);
      const at = anchor.index;
      out = raw.slice(0, at) + block + raw.slice(at);
    }
    fs.writeFileSync(filePath, out);
  }
  console.log(`master file lists  ${rows.length} entries in ${MASTER_FILE_LISTS.length} files`);
}

function writeConfig(builds: StageBuild[]): void {
  writeLevelConfig(builds);
  writeDoorMap(builds);
  writeDoorSpawns(builds);
  writeCompletionConditions(builds);
  writeEnemyElements(builds);
  writeMasterFileLists(builds);
}

function main(): void {
  const { survey, stages } = parseArgs(process.argv);
  const builds: StageBuild[] = [];
  for (const spec of stages) {
    const build = buildStage(spec, LEGENDS_INN_STAGES.indexOf(spec), survey);
    if (build) builds.push(build);
  }
  if (survey) return;

  const total = stages.reduce((sum, spec) => {
    const file = path.join(OUT_DIR, spec.outFile);
    return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
  console.log(`\ntotal ${(total / 1024 / 1024).toFixed(2)} MB across ${stages.length} stage SWFs`);

  if (builds.length !== LEGENDS_INN_STAGES.length) {
    console.log("partial build - config not rewritten, run without --stage to update it");
    return;
  }
  console.log("");
  writeConfig(builds);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
