/**
 * The Legends' Inn stage list.
 *
 * Legends' Inn is a tour of Ellyria: one authored dungeon from each region, kept
 * whole, chained end to end. Two tools need the same list - the SWF build and the
 * Game.swz registration - so it lives here rather than in either of them.
 *
 * Stage order is the order the regions unlock in the campaign.
 */
export interface LegendsInnStage {
  /** Region the dungeon belongs to, and the second half of the display name. */
  region: string;
  /** Server map name. */
  levelName: string;
  /** Region SWF the stage is trimmed out of. */
  swf: string;
  levelClass: string;
  outFile: string;
  /**
   * The shipped dungeon this stage is a copy of. Its enemy catalog, completion
   * condition and LevelType are reused rather than re-derived - it is the same
   * rooms, the same enemies and the same region.
   */
  sourceLevelName: string;
  /**
   * Room the exit portal is placed in. Defaults to the room holding am_Boss,
   * which is where a dungeon's fight ends.
   */
  bossRoom?: string;
  /** Nudges the portal off the boss's own anchor, in room-local pixels. */
  exitOffset?: { x: number; y: number };
}

/** Where the dungeon is entered from, and where the last stage lets out. */
export const ENTRY_LEVEL = "CraftTown";
export const ENTRY_DOOR_ID = 101;
/** Every stage keeps a way straight back out, on the door the dungeon shipped with. */
export const RETURN_DOOR_ID = 1;

export const LEGENDS_INN_STAGES: LegendsInnStage[] = [
  {
    region: "Wolf's End",
    levelName: "LegendsInn1",
    swf: "cbp/LevelsNR.swf",
    levelClass: "a_Level_GoblinRiver",
    outFile: "LevelsLI01.swf",
    sourceLevelName: "GoblinRiverDungeon",
  },
  {
    region: "Blackrose Mire",
    levelName: "LegendsInn2",
    swf: "cbp/LevelsSRN.swf",
    levelClass: "a_Level_SRNMission7Svath",
    outFile: "LevelsLI02.swf",
    sourceLevelName: "SRN_Mission7",
  },
  {
    region: "Bridgetown",
    levelName: "LegendsInn3",
    swf: "cam/LevelsBT.swf",
    levelClass: "a_Level_BTMission1",
    outFile: "LevelsLI03.swf",
    sourceLevelName: "BT_Mission1",
  },
  {
    region: "Cemetery Hill",
    levelName: "LegendsInn4",
    swf: "cam/LevelsCH.swf",
    levelClass: "a_Level_CHMission3",
    outFile: "LevelsLI04.swf",
    sourceLevelName: "CH_Mission3",
  },
  {
    region: "Stormshard",
    levelName: "LegendsInn5",
    swf: "cbp/LevelsOMM.swf",
    levelClass: "a_Level_OMMMission06ForgottenForge",
    outFile: "LevelsLI05.swf",
    sourceLevelName: "OMM_Mission6",
  },
  {
    region: "Emerald Glades",
    levelName: "LegendsInn6",
    swf: "cam/LevelsEG.swf",
    levelClass: "a_Level_EGMission5",
    outFile: "LevelsLI06.swf",
    sourceLevelName: "EG_Mission5",
  },
  {
    region: "Deepgard Castle",
    levelName: "LegendsInn7",
    swf: "cbp/LevelsAC.swf",
    levelClass: "a_Level_TheEmeraldThrone",
    outFile: "LevelsLI07.swf",
    sourceLevelName: "AC_Mission2",
  },
  {
    region: "Shazari Desert",
    levelName: "LegendsInn8",
    swf: "cam/LevelsSD.swf",
    levelClass: "a_Level_SDMission1",
    outFile: "LevelsLI08.swf",
    sourceLevelName: "SD_Mission1",
  },
  {
    region: "Valhaven",
    levelName: "LegendsInn9",
    swf: "cbp/LevelsJC.swf",
    levelClass: "a_Level_JCMini1",
    outFile: "LevelsLI09.swf",
    sourceLevelName: "JC_Mini1",
  },
];

/** Matches every level name this feature owns, so a rebuild replaces its own entries. */
export const LEGENDS_INN_LEVEL = /^LegendsInn\d*$/;

/**
 * What every stage is called in game.
 *
 * All nine share one name on purpose: the stages are one dungeon to the player,
 * walked end to end through the portals, not nine dungeons in a row. Naming the
 * borrowed dungeon or its region on the plate would give that away.
 */
export function legendsInnDisplayName(): string {
  // A literal apostrophe, matching how "Wolf's End" is already stored in Game.swz.
  return "Legends' Inn";
}
