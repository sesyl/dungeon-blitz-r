/**
 * Registers the Legends' Inn dungeon with the client's game data.
 *
 * Two chunks of Game.swz are touched:
 *   - LevelTypes gains the level so the client has a display name and music for it,
 *   - DoorTypes gains the Craft Town portal (CraftTown door 101) and the way back
 *     out of the dungeon (LegendsInn door 1).
 *
 * The matching artwork is the a_Door_101 portal added to LevelsHome.swf by
 * patch-levelshome-legends-inn-portal.ts; without these entries the client draws
 * the portal but has nowhere to send the player.
 *
 * Usage: npm exec ts-node scripts/patch_gameswz_legends_inn.ts [--verify] [--swz-path <file>]
 */
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const LEVEL_NAME = "LegendsInn";
// A literal apostrophe, matching how "Wolf's End" is already stored in this chunk.
const DISPLAY_NAME = "Legends' Inn";
const ZONE_SET = "JadeCity";
const MUSIC_LOOP = "OminousDungeonLongLoopWithSomeDrama_29.mp3";
const RANKINGS_URL = "legendsinn";
const HOME_MAP = "CraftTown";
const HOME_DOOR_ID = 101;
const EXIT_DOOR_ID = 1;

export interface LegendsInnSwzStats {
  levelTypeAdded: boolean;
  doorTypesAdded: number;
}

function defaultGameSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz");
}

function resolveArgPath(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? path.resolve(args[index + 1]) : fallback;
}

function buildLevelType(newline: string): string {
  return [
    "\t<LevelType LevelName=\"" + LEVEL_NAME + "\">",
    `\t\t<ZoneSet>${ZONE_SET}</ZoneSet>`,
    `\t\t<DisplayName>${DISPLAY_NAME}</DisplayName>`,
    `\t\t<RankingsURL>${RANKINGS_URL}</RankingsURL>`,
    `\t\t<MusicLoop>${MUSIC_LOOP}</MusicLoop>`,
    "\t</LevelType>",
  ].join(newline);
}

function buildDoorType(
  mapName: string,
  doorId: number,
  targetMapName: string,
  targetDoorId: number,
  newline: string,
): string {
  return [
    "\t<DoorType>",
    `\t\t<MapName>${mapName}</MapName>`,
    `\t\t<DoorID>${doorId}</DoorID>`,
    `\t\t<TargetMapName>${targetMapName}</TargetMapName>`,
    `\t\t<TargetDoorID>${targetDoorId}</TargetDoorID>`,
    "\t</DoorType>",
  ].join(newline);
}

export function patchLevelTypes(xml: string): { xml: string; added: boolean } {
  if (xml.includes(`LevelName="${LEVEL_NAME}"`)) return { xml, added: false };
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const closing = xml.lastIndexOf("</LevelTypes>");
  if (closing === -1) throw new SwzPatchError("LevelTypes chunk has no closing tag");
  return {
    xml: xml.slice(0, closing) + buildLevelType(newline) + newline + xml.slice(closing),
    added: true,
  };
}

export function patchDoorTypes(xml: string): { xml: string; added: number } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const closing = xml.lastIndexOf("</DoorTypes>");
  if (closing === -1) throw new SwzPatchError("DoorTypes chunk has no closing tag");

  const blocks: string[] = [];
  const has = (mapName: string, doorId: number) =>
    new RegExp(`<MapName>${mapName}</MapName>\\s*<DoorID>${doorId}</DoorID>`).test(xml);

  if (!has(HOME_MAP, HOME_DOOR_ID)) {
    blocks.push(buildDoorType(HOME_MAP, HOME_DOOR_ID, LEVEL_NAME, EXIT_DOOR_ID, newline));
  }
  if (!has(LEVEL_NAME, EXIT_DOOR_ID)) {
    blocks.push(buildDoorType(LEVEL_NAME, EXIT_DOOR_ID, HOME_MAP, HOME_DOOR_ID, newline));
  }
  if (blocks.length === 0) return { xml, added: 0 };

  return {
    xml: xml.slice(0, closing) + blocks.join(newline) + newline + xml.slice(closing),
    added: blocks.length,
  };
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): LegendsInnSwzStats {
  const ctx = parseSwz(swzPath);
  const levelTypes = ctx.chunks.find((chunk) => chunk.xml.includes("<LevelTypes"));
  const doorTypes = ctx.chunks.find((chunk) => chunk.xml.includes("<DoorTypes"));
  if (!levelTypes) throw new SwzPatchError("LevelTypes chunk not found in Game.swz");
  if (!doorTypes) throw new SwzPatchError("DoorTypes chunk not found in Game.swz");

  const level = patchLevelTypes(levelTypes.xml);
  const doors = patchDoorTypes(doorTypes.xml);

  if (!verifyOnly && (level.added || doors.added > 0)) {
    ensureBackup(swzPath);
    levelTypes.xml = level.xml;
    doorTypes.xml = doors.xml;
    writeSwz(ctx);
  }

  return { levelTypeAdded: level.added, doorTypesAdded: doors.added };
}

function main(): void {
  const args = process.argv.slice(2);
  const swzPath = resolveArgPath(args, "--swz-path", defaultGameSwzPath());
  const verifyOnly = args.includes("--verify");
  const stats = patchGameSwz(swzPath, verifyOnly);

  console.log(`SWZ: ${swzPath}`);
  console.log(`LevelType added: ${stats.levelTypeAdded}`);
  console.log(`DoorTypes added: ${stats.doorTypesAdded}`);

  if (verifyOnly && (stats.levelTypeAdded || stats.doorTypesAdded > 0)) {
    throw new SwzPatchError("Game.swz is missing the Legends' Inn entries");
  }
}

if (require.main === module) {
  main();
}
